import type {
  FigmaBatchOperationInput,
  FigmaOperationInput,
  FigmaSnapshot,
  FigmaNode,
  FigmaVariable
} from "./schemas.js";

const SUPPORTED_CREATE_TYPES = new Set(["FRAME", "TEXT", "RECTANGLE", "ELLIPSE", "COMPONENT", "SECTION"]);
const SUPPORTED_SHARED_PATCH_FIELDS = new Set([
  "name",
  "visible",
  "locked",
  "x",
  "y",
  "rotation",
  "width",
  "height",
  "opacity",
  "fills",
  "strokes",
  "cornerRadius",
  "layoutMode",
  "itemSpacing",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "characters",
  "fontName",
  "fontSize"
]);

// ---------------------------------------------------------------------------
// Resolution result types
// ---------------------------------------------------------------------------

type ResolutionIssue = {
  index: number;
  message: string;
};

type ResolutionNote = {
  index: number;
  message: string;
};

type ResolutionSummary = {
  index: number;
  operationType: FigmaBatchOperationInput["type"];
  resolvedNodeId?: string;
  resolvedParentId?: string;
  resolvedVariableId?: string;
  /** Original selector string that was resolved. */
  selectorUsed?: string;
  /** Number of nodes that matched the final path segment. */
  matchCount?: number;
  /** IDs of all candidates when matchCount > 1 (ambiguity). */
  matchedNodeIds?: string[];
};

type ResolvedBatchResult = {
  resolvedOperations: FigmaOperationInput[];
  errors: ResolutionIssue[];
  warnings: ResolutionIssue[];
  notes: ResolutionNote[];
  resolutions: ResolutionSummary[];
};

// ---------------------------------------------------------------------------
// Snapshot index
// ---------------------------------------------------------------------------

type SnapshotIndex = {
  nodeMap: Map<string, FigmaNode>;
  variableMap: Map<string, FigmaVariable>;
  roots: FigmaNode[];
};

function buildSnapshotIndex(snapshot: FigmaSnapshot): SnapshotIndex {
  const nodeMap = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const variableMap = new Map(snapshot.variables.map((variable) => [variable.id, variable]));
  const roots = snapshot.nodes.filter((node) => !node.parentId || !nodeMap.has(node.parentId));
  return { nodeMap, variableMap, roots };
}

function getChildren(index: SnapshotIndex, parent: FigmaNode | undefined): FigmaNode[] {
  const source = parent ? parent.childIds : index.roots.map((node) => node.id);
  return source
    .map((childId) => index.nodeMap.get(childId))
    .filter((node): node is FigmaNode => Boolean(node));
}

// ---------------------------------------------------------------------------
// Selector parsing
// ---------------------------------------------------------------------------

type ParsedSegment = {
  /** Name matcher: literal name, "*" for wildcard, or "#id" for direct id. */
  matcher: string;
  /** Node type filter (uppercase), e.g. "FRAME", "TEXT". Undefined = any type. */
  typeFilter?: string;
  /** 1-indexed occurrence within matches. 0 means "not specified" (may trigger ambiguity). */
  occurrence: number;
  /** Whether this is the recursive descendant wildcard "**". */
  isRecursive: boolean;
};

/**
 * Parse a single path segment into its components.
 *
 * Supported syntax:
 *   Name           → match by name, any type
 *   Name[N]        → Nth occurrence (1-indexed), any type
 *   Name:TYPE      → match by name AND type
 *   Name:TYPE[N]   → Nth occurrence matching name AND type
 *   *              → match any child
 *   *:TYPE         → match any child of given type
 *   **             → recursive descendant marker
 *   #id            → direct node id
 */
function parsePathSegment(segment: string): ParsedSegment {
  const trimmed = segment.trim();

  // Recursive descendant wildcard
  if (trimmed === "**") {
    return { matcher: "**", occurrence: 0, isRecursive: true };
  }

  // Regex: (name_or_hash_or_star) optionally (:TYPE, case-insensitive) optionally ([N])
  const match = /^(.*?)(?::([A-Za-z_]+))?(?:\[(\d+)\])?$/.exec(trimmed);
  if (!match) {
    return { matcher: trimmed, occurrence: 0, isRecursive: false };
  }

  return {
    matcher: match[1] ?? trimmed,
    typeFilter: match[2] ? match[2].toUpperCase() : undefined,
    occurrence: match[3] ? Number.parseInt(match[3], 10) : 0,
    isRecursive: false,
  };
}

/**
 * Test whether a node matches a parsed segment.
 */
function nodeMatchesSegment(node: FigmaNode, segment: ParsedSegment): boolean {
  // Direct id match
  if (segment.matcher.startsWith("#")) {
    if (node.id !== segment.matcher.slice(1)) {
      return false;
    }
    // If a type filter is also specified, check it
    if (segment.typeFilter && node.type.toUpperCase() !== segment.typeFilter) {
      return false;
    }
    return true;
  }

  // Wildcard name match
  if (segment.matcher === "*") {
    if (segment.typeFilter && node.type.toUpperCase() !== segment.typeFilter) {
      return false;
    }
    return true;
  }

  // Exact name match
  if (node.name !== segment.matcher) {
    return false;
  }

  // Optional type filter
  if (segment.typeFilter && node.type.toUpperCase() !== segment.typeFilter) {
    return false;
  }

  return true;
}

/**
 * Collect all descendants of a set of parent nodes (depth-first).
 */
function collectDescendants(index: SnapshotIndex, parents: Array<FigmaNode | undefined>): FigmaNode[] {
  const result: FigmaNode[] = [];
  const visited = new Set<string>();

  function walk(parent: FigmaNode | undefined): void {
    const children = getChildren(index, parent);
    for (const child of children) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      result.push(child);
      walk(child);
    }
  }

  for (const parent of parents) {
    walk(parent);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Path resolution (core)
// ---------------------------------------------------------------------------

type PathResolutionResult = {
  node: FigmaNode;
  /** Total matches for the final segment (before occurrence selection). */
  matchCount: number;
  /** IDs of all matched candidates for the final segment. */
  matchedNodeIds: string[];
  /** Whether the final segment had an explicit [N] index. */
  explicitIndex: boolean;
};

/**
 * Resolve a node path selector against the snapshot index.
 *
 * Path syntax:
 *   "Hero/Button"       → name path
 *   "Hero/Button[2]"    → 2nd Button child of Hero
 *   "Hero/Button:FRAME" → Button child of type FRAME
 *   "Hero/*:TEXT"        → any TEXT child of Hero
 *   "Hero/ ** /Button"   → recursive descendant named Button under Hero
 *   "#node-id"          → direct id (standalone)
 *   "#node-id/Child"    → id-addressed parent, then name child
 */
function resolveNodePathInternal(index: SnapshotIndex, path: string): PathResolutionResult {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error("nodePath cannot be empty");
  }

  // Standalone #id or #id:TYPE (no slashes) — fast path
  if (trimmed.startsWith("#") && !trimmed.includes("/")) {
    const parsed = parsePathSegment(trimmed);
    const nodeId = parsed.matcher.slice(1); // remove "#"
    const node = index.nodeMap.get(nodeId);
    if (!node) {
      throw new Error(`No node found for id "${nodeId}"`);
    }
    // Validate type filter if specified
    if (parsed.typeFilter && node.type.toUpperCase() !== parsed.typeFilter) {
      throw new Error(`Node "${nodeId}" exists but has type "${node.type}", not "${parsed.typeFilter}"`);
    }
    return { node, matchCount: 1, matchedNodeIds: [node.id], explicitIndex: false };
  }

  const rawSegments = trimmed.split("/").filter(Boolean);
  const segments = rawSegments.map(parsePathSegment);

  let currentParents: Array<FigmaNode | undefined> = [undefined];
  let lastMatches: FigmaNode[] = [];
  let lastExplicitIndex = false;

  let i = 0;
  while (i < segments.length) {
    const segment = segments[i]!;

    // Handle ** recursive descendant
    if (segment.isRecursive) {
      if (i + 1 >= segments.length) {
        throw new Error(`Path "**" must be followed by a concrete segment`);
      }
      // Collect all descendants of current parents
      const descendants = collectDescendants(index, currentParents);
      // The NEXT segment is the actual matcher to apply on descendants
      i += 1;
      const nextSegment = segments[i]!;
      if (nextSegment.isRecursive) {
        throw new Error(`Consecutive "**" segments are not allowed`);
      }

      const matches = descendants.filter((node) => nodeMatchesSegment(node, nextSegment));
      lastMatches = matches;

      if (matches.length === 0) {
        throw new Error(`Recursive descendant selector "**/${rawSegments[i]}" did not match any node`);
      }

      const occurrence = nextSegment.occurrence;
      if (occurrence > 0) {
        if (occurrence > matches.length) {
          throw new Error(`Recursive descendant selector "**/${rawSegments[i]}" requested occurrence ${occurrence}, but only ${matches.length} match(es) exist`);
        }
        currentParents = [matches[occurrence - 1]];
        lastExplicitIndex = true;
      } else {
        // No explicit index — use first match (ambiguity is reported by caller)
        currentParents = [matches[0]];
        lastExplicitIndex = false;
      }

      i += 1;
      continue;
    }

    // Normal segment resolution
    const candidates: FigmaNode[] = [];
    for (const parent of currentParents) {
      for (const child of getChildren(index, parent)) {
        if (nodeMatchesSegment(child, segment)) {
          candidates.push(child);
        }
      }
    }

    lastMatches = candidates;

    if (candidates.length === 0) {
      const segmentDesc = rawSegments[i] ?? segment.matcher;
      throw new Error(`Path segment "${segmentDesc}" did not match any node`);
    }

    const occurrence = segment.occurrence;
    if (occurrence > 0) {
      if (occurrence > candidates.length) {
        throw new Error(`Path segment "${rawSegments[i]}" requested occurrence ${occurrence}, but only ${candidates.length} match(es) exist`);
      }
      currentParents = [candidates[occurrence - 1]];
      lastExplicitIndex = true;
    } else {
      // No explicit index — use first match
      currentParents = [candidates[0]];
      lastExplicitIndex = false;
    }

    i += 1;
  }

  const resolvedNode = currentParents[0];
  if (!resolvedNode) {
    throw new Error(`Failed to resolve path "${path}"`);
  }

  return {
    node: resolvedNode,
    matchCount: lastMatches.length,
    matchedNodeIds: lastMatches.map((n) => n.id),
    explicitIndex: lastExplicitIndex,
  };
}

// ---------------------------------------------------------------------------
// Public resolveNodePath (backwards-compatible signature)
// ---------------------------------------------------------------------------

function resolveNodePath(index: SnapshotIndex, path: string): FigmaNode {
  return resolveNodePathInternal(index, path).node;
}

/**
 * Resolve a node path and return full diagnostics including ambiguity info.
 */
function resolveNodePathWithDiagnostics(
  index: SnapshotIndex,
  path: string,
): PathResolutionResult {
  return resolveNodePathInternal(index, path);
}

// ---------------------------------------------------------------------------
// Variable resolution
// ---------------------------------------------------------------------------

function resolveVariable(index: SnapshotIndex, variableId?: string, variableName?: string): FigmaVariable {
  if (variableId) {
    const variable = index.variableMap.get(variableId);
    if (!variable) {
      throw new Error(`Variable "${variableId}" was not found`);
    }
    return variable;
  }

  const matches = [...index.variableMap.values()].filter((variable) => variable.name === variableName);
  if (matches.length === 0) {
    throw new Error(`Variable "${variableName}" was not found`);
  }
  if (matches.length > 1) {
    throw new Error(`Variable "${variableName}" is ambiguous; ${matches.length} matches found: ${matches.map((v) => v.id).join(", ")}`);
  }
  return matches[0]!;
}

// ---------------------------------------------------------------------------
// Node resolution (id or path)
// ---------------------------------------------------------------------------

function resolveNode(index: SnapshotIndex, nodeId?: string, nodePath?: string): FigmaNode {
  if (nodeId) {
    const node = index.nodeMap.get(nodeId);
    if (!node) {
      throw new Error(`Node "${nodeId}" was not found in snapshot (${index.nodeMap.size} nodes available)`);
    }
    return node;
  }
  if (!nodePath) {
    throw new Error("nodeId or nodePath is required");
  }
  return resolveNodePath(index, nodePath);
}

/**
 * Resolve a node (id or path) with full diagnostics.
 */
function resolveNodeWithDiagnostics(
  index: SnapshotIndex,
  nodeId?: string,
  nodePath?: string,
): { node: FigmaNode; diagnostics: PathResolutionResult | null } {
  if (nodeId) {
    const node = index.nodeMap.get(nodeId);
    if (!node) {
      throw new Error(`Node "${nodeId}" was not found in snapshot (${index.nodeMap.size} nodes available)`);
    }
    return { node, diagnostics: null };
  }
  if (!nodePath) {
    throw new Error("nodeId or nodePath is required");
  }
  const diagnostics = resolveNodePathWithDiagnostics(index, nodePath);
  return { node: diagnostics.node, diagnostics };
}

// ---------------------------------------------------------------------------
// Resolution summary helpers
// ---------------------------------------------------------------------------

function addSummary(
  resolutions: ResolutionSummary[],
  index: number,
  operation: FigmaBatchOperationInput["type"],
  summary: Omit<ResolutionSummary, "index" | "operationType">
): void {
  resolutions.push({
    index,
    operationType: operation,
    ...summary
  });
}

/**
 * If a path resolution is ambiguous (matchCount > 1 with no explicit [N]),
 * add a structured warning.
 */
function checkAmbiguity(
  warnings: ResolutionIssue[],
  operationIndex: number,
  selectorUsed: string,
  diagnostics: PathResolutionResult | null,
): void {
  if (!diagnostics) return;
  if (diagnostics.matchCount > 1 && !diagnostics.explicitIndex) {
    warnings.push({
      index: operationIndex,
      message: `Selector "${selectorUsed}" matched ${diagnostics.matchCount} nodes: [${diagnostics.matchedNodeIds.join(", ")}]. Using first match "${diagnostics.node.id}". Use an explicit index like [1] or [2] to disambiguate.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Batch resolution (main export)
// ---------------------------------------------------------------------------

export function resolveBatchOperations(snapshot: FigmaSnapshot | null, operations: FigmaBatchOperationInput[]): ResolvedBatchResult {
  const result: ResolvedBatchResult = {
    resolvedOperations: [],
    errors: [],
    warnings: [],
    notes: [],
    resolutions: []
  };

  if (!snapshot) {
    result.errors.push({
      index: -1,
      message: "No snapshot is available for this session. Run the Figma plugin worker and publish a snapshot first."
    });
    return result;
  }

  const index = buildSnapshotIndex(snapshot);

  operations.forEach((operation, operationIndex) => {
    try {
      switch (operation.type) {
        case "create_node": {
          const createType = typeof operation.node.type === "string" ? operation.node.type.toUpperCase() : undefined;
          if (!createType || !SUPPORTED_CREATE_TYPES.has(createType)) {
            result.errors.push({
              index: operationIndex,
              message: `create_node only supports ${[...SUPPORTED_CREATE_TYPES].join(", ")} in the current plugin executor`
            });
            return;
          }

          const ignoredFields = Object.keys(operation.node).filter((field) => field !== "type" && !SUPPORTED_SHARED_PATCH_FIELDS.has(field));
          if (ignoredFields.length > 0) {
            result.warnings.push({
              index: operationIndex,
              message: `create_node will ignore unsupported fields: ${ignoredFields.join(", ")}`
            });
          }

          let parentId = operation.parentId;
          let parentDiagnostics: PathResolutionResult | null = null;
          if (!parentId && operation.parentPath) {
            const res = resolveNodePathWithDiagnostics(index, operation.parentPath);
            parentId = res.node.id;
            parentDiagnostics = res;
            checkAmbiguity(result.warnings, operationIndex, operation.parentPath, parentDiagnostics);
          }

          result.resolvedOperations.push({
            type: "create_node",
            parentId,
            index: operation.index,
            node: operation.node,
            position: operation.position
          });
          addSummary(result.resolutions, operationIndex, operation.type, {
            resolvedParentId: parentId,
            selectorUsed: operation.parentPath ?? operation.parentId,
            matchCount: parentDiagnostics?.matchCount,
            matchedNodeIds: parentDiagnostics?.matchedNodeIds,
          });
          return;
        }
        case "create_instance": {
          let parentId = operation.parentId;
          let parentDiagnostics: PathResolutionResult | null = null;
          if (!parentId && operation.parentPath) {
            const res = resolveNodePathWithDiagnostics(index, operation.parentPath);
            parentId = res.node.id;
            parentDiagnostics = res;
            checkAmbiguity(result.warnings, operationIndex, operation.parentPath, parentDiagnostics);
          }

          result.resolvedOperations.push({
            type: "create_instance",
            componentId: operation.componentId,
            componentKey: operation.componentKey,
            parentId,
            index: operation.index,
            position: operation.position,
            variantProperties: operation.variantProperties,
            componentProperties: operation.componentProperties,
            textOverrides: operation.textOverrides
          });
          addSummary(result.resolutions, operationIndex, operation.type, {
            resolvedParentId: parentId,
            resolvedNodeId: operation.componentId,
            selectorUsed: operation.parentPath ?? operation.parentId,
            matchCount: parentDiagnostics?.matchCount,
            matchedNodeIds: parentDiagnostics?.matchedNodeIds,
          });
          return;
        }
        case "update_node": {
          const selectorUsed = operation.nodePath ?? operation.nodeId;
          const { node, diagnostics } = resolveNodeWithDiagnostics(index, operation.nodeId, operation.nodePath);
          checkAmbiguity(result.warnings, operationIndex, selectorUsed ?? "", diagnostics);

          const ignoredFields = Object.keys(operation.patch).filter((field) => !SUPPORTED_SHARED_PATCH_FIELDS.has(field));
          if (ignoredFields.length > 0) {
            result.warnings.push({
              index: operationIndex,
              message: `update_node will ignore unsupported patch fields: ${ignoredFields.join(", ")}`
            });
          }
          result.resolvedOperations.push({
            type: "update_node",
            nodeId: node.id,
            patch: operation.patch
          });
          addSummary(result.resolutions, operationIndex, operation.type, {
            resolvedNodeId: node.id,
            selectorUsed,
            matchCount: diagnostics?.matchCount,
            matchedNodeIds: diagnostics?.matchedNodeIds,
          });
          return;
        }
        case "delete_node": {
          const selectorUsed = operation.nodePath ?? operation.nodeId;
          const { node, diagnostics } = resolveNodeWithDiagnostics(index, operation.nodeId, operation.nodePath);
          checkAmbiguity(result.warnings, operationIndex, selectorUsed ?? "", diagnostics);

          result.resolvedOperations.push({
            type: "delete_node",
            nodeId: node.id
          });
          addSummary(result.resolutions, operationIndex, operation.type, {
            resolvedNodeId: node.id,
            selectorUsed,
            matchCount: diagnostics?.matchCount,
            matchedNodeIds: diagnostics?.matchedNodeIds,
          });
          return;
        }
        case "move_node": {
          const selectorUsed = operation.nodePath ?? operation.nodeId;
          const { node, diagnostics } = resolveNodeWithDiagnostics(index, operation.nodeId, operation.nodePath);
          checkAmbiguity(result.warnings, operationIndex, selectorUsed ?? "", diagnostics);

          let parentId = operation.parentId;
          let parentDiagnostics: PathResolutionResult | null = null;
          if (!parentId && operation.parentPath) {
            const res = resolveNodePathWithDiagnostics(index, operation.parentPath);
            parentId = res.node.id;
            parentDiagnostics = res;
            checkAmbiguity(result.warnings, operationIndex, operation.parentPath, parentDiagnostics);
          }

          result.resolvedOperations.push({
            type: "move_node",
            nodeId: node.id,
            parentId,
            index: operation.index,
            position: operation.position
          });
          addSummary(result.resolutions, operationIndex, operation.type, {
            resolvedNodeId: node.id,
            resolvedParentId: parentId,
            selectorUsed,
            matchCount: diagnostics?.matchCount,
            matchedNodeIds: diagnostics?.matchedNodeIds,
          });
          return;
        }
        case "set_variable": {
          const variable = resolveVariable(index, operation.variableId, operation.variableName);
          result.resolvedOperations.push({
            type: "set_variable",
            variableId: variable.id,
            value: operation.value
          });
          addSummary(result.resolutions, operationIndex, operation.type, {
            resolvedVariableId: variable.id,
            selectorUsed: operation.variableName ?? operation.variableId,
          });
          return;
        }
        case "set_selection": {
          const resolvedIds: string[] = [...(operation.selectionIds ?? [])];
          for (const selPath of operation.selectionPaths ?? []) {
            const res = resolveNodePathWithDiagnostics(index, selPath);
            resolvedIds.push(res.node.id);
            checkAmbiguity(result.warnings, operationIndex, selPath, res);
          }
          result.resolvedOperations.push({
            type: "set_selection",
            selectionIds: resolvedIds
          });
          result.notes.push({
            index: operationIndex,
            message: `Resolved ${resolvedIds.length} selection target(s)`
          });
          return;
        }
        case "run_plugin_action": {
          const payload = { ...operation.payload };
          if (operation.action === "scroll_into_view" && typeof payload.nodePath === "string" && !payload.nodeId) {
            const res = resolveNodePathWithDiagnostics(index, payload.nodePath as string);
            payload.nodeId = res.node.id;
            checkAmbiguity(result.warnings, operationIndex, payload.nodePath as string, res);
            delete payload.nodePath;
          }
          result.resolvedOperations.push({
            type: "run_plugin_action",
            action: operation.action,
            payload
          });
          return;
        }
        default: {
          const exhaustiveCheck: never = operation;
          throw new Error(`Unsupported batch operation ${JSON.stringify(exhaustiveCheck)}`);
        }
      }
    } catch (error) {
      result.errors.push({
        index: operationIndex,
        message: String(error)
      });
    }
  });

  return result;
}
