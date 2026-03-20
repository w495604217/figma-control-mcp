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
};

type ResolvedBatchResult = {
  resolvedOperations: FigmaOperationInput[];
  errors: ResolutionIssue[];
  warnings: ResolutionIssue[];
  notes: ResolutionNote[];
  resolutions: ResolutionSummary[];
};

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

function parsePathSegment(segment: string): { matcher: string; occurrence: number } {
  const trimmed = segment.trim();
  const match = /^(.*?)(?:\[(\d+)\])?$/.exec(trimmed);
  if (!match) {
    return { matcher: trimmed, occurrence: 1 };
  }
  return {
    matcher: match[1] ?? trimmed,
    occurrence: match[2] ? Number.parseInt(match[2], 10) : 1
  };
}

function resolveNodePath(index: SnapshotIndex, path: string): FigmaNode {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error("nodePath cannot be empty");
  }

  if (trimmed.startsWith("#") && !trimmed.includes("/")) {
    const node = index.nodeMap.get(trimmed.slice(1));
    if (!node) {
      throw new Error(`No node found for id ${trimmed.slice(1)}`);
    }
    return node;
  }

  const segments = trimmed.split("/").filter(Boolean);
  let currentParents: Array<FigmaNode | undefined> = [undefined];

  for (const segment of segments) {
    const { matcher, occurrence } = parsePathSegment(segment);
    const matches: FigmaNode[] = [];

    for (const parent of currentParents) {
      for (const child of getChildren(index, parent)) {
        if (matcher.startsWith("#")) {
          if (child.id === matcher.slice(1)) {
            matches.push(child);
          }
          continue;
        }

        if (child.name === matcher) {
          matches.push(child);
        }
      }
    }

    if (matches.length === 0) {
      throw new Error(`Path segment "${segment}" did not match any node`);
    }

    if (occurrence < 1 || occurrence > matches.length) {
      throw new Error(`Path segment "${segment}" requested occurrence ${occurrence}, but only ${matches.length} match(es) exist`);
    }

    currentParents = [matches[occurrence - 1]];
  }

  if (!currentParents[0]) {
    throw new Error(`Failed to resolve path ${path}`);
  }

  return currentParents[0];
}

function resolveVariable(index: SnapshotIndex, variableId?: string, variableName?: string): FigmaVariable {
  if (variableId) {
    const variable = index.variableMap.get(variableId);
    if (!variable) {
      throw new Error(`Variable ${variableId} was not found`);
    }
    return variable;
  }

  const matches = [...index.variableMap.values()].filter((variable) => variable.name === variableName);
  if (matches.length === 0) {
    throw new Error(`Variable "${variableName}" was not found`);
  }
  if (matches.length > 1) {
    throw new Error(`Variable "${variableName}" is ambiguous; ${matches.length} matches found`);
  }
  return matches[0]!;
}

function resolveNode(index: SnapshotIndex, nodeId?: string, nodePath?: string): FigmaNode {
  if (nodeId) {
    const node = index.nodeMap.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} was not found`);
    }
    return node;
  }
  if (!nodePath) {
    throw new Error("nodeId or nodePath is required");
  }
  return resolveNodePath(index, nodePath);
}

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
          if (!parentId && operation.parentPath) {
            parentId = resolveNodePath(index, operation.parentPath).id;
          }

          result.resolvedOperations.push({
            type: "create_node",
            parentId,
            index: operation.index,
            node: operation.node,
            position: operation.position
          });
          addSummary(result.resolutions, operationIndex, operation.type, {
            resolvedParentId: parentId
          });
          return;
        }
        case "create_instance": {
          let parentId = operation.parentId;
          if (!parentId && operation.parentPath) {
            parentId = resolveNodePath(index, operation.parentPath).id;
          }

          result.resolvedOperations.push({
            type: "create_instance",
            componentId: operation.componentId,
            componentKey: operation.componentKey,
            parentId,
            index: operation.index,
            position: operation.position
          });
          addSummary(result.resolutions, operationIndex, operation.type, {
            resolvedParentId: parentId,
            resolvedNodeId: operation.componentId
          });
          return;
        }
        case "update_node": {
          const node = resolveNode(index, operation.nodeId, operation.nodePath);
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
            resolvedNodeId: node.id
          });
          return;
        }
        case "delete_node": {
          const node = resolveNode(index, operation.nodeId, operation.nodePath);
          result.resolvedOperations.push({
            type: "delete_node",
            nodeId: node.id
          });
          addSummary(result.resolutions, operationIndex, operation.type, {
            resolvedNodeId: node.id
          });
          return;
        }
        case "move_node": {
          const node = resolveNode(index, operation.nodeId, operation.nodePath);
          let parentId = operation.parentId;
          if (!parentId && operation.parentPath) {
            parentId = resolveNodePath(index, operation.parentPath).id;
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
            resolvedParentId: parentId
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
            resolvedVariableId: variable.id
          });
          return;
        }
        case "set_selection": {
          const resolvedIds = [
            ...(operation.selectionIds ?? []),
            ...((operation.selectionPaths ?? []).map((path) => resolveNodePath(index, path).id))
          ];
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
            payload.nodeId = resolveNodePath(index, payload.nodePath).id;
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
