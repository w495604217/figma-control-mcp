import { BridgeStore } from "./bridge-store.js";
import type { FigmaComponentSummary, FigmaNode, FigmaSession, FigmaSnapshot, FigmaVariable } from "./schemas.js";
import { TalkToFigmaClient } from "./talk-to-figma.js";

type TalkToFigmaExecutor = Pick<TalkToFigmaClient, "executeCommand">;

type SyncTalkToFigmaChannelInput = {
  store: BridgeStore;
  channel: string;
  sessionId?: string;
  wsUrl?: string;
  timeoutMs?: number;
  client?: TalkToFigmaExecutor;
};

type JsonRecord = Record<string, unknown>;

const TALK_TO_FIGMA_SYNC_CODE = `
function getBounds(node) {
  if (
    typeof node.x === 'number' &&
    typeof node.y === 'number' &&
    typeof node.width === 'number' &&
    typeof node.height === 'number'
  ) {
    return { x: node.x, y: node.y, width: node.width, height: node.height };
  }
  return undefined;
}

function serializeNode(node, parentId) {
  return {
    id: node.id,
    name: node.name || '',
    type: node.type,
    parentId,
    childIds: 'children' in node ? node.children.map((child) => child.id) : [],
    visible: 'visible' in node ? node.visible : undefined,
    locked: 'locked' in node ? node.locked : undefined,
    bounds: getBounds(node)
  };
}

function walk(node, parentId, nodes, components) {
  nodes.push(serializeNode(node, parentId));

  if (node.type === 'COMPONENT') {
    components.push({
      id: node.id,
      key: node.key || undefined,
      name: node.name || '',
      nodeId: node.id,
      pageId: figma.currentPage.id,
      pageName: figma.currentPage.name,
      componentSetId: node.parent && node.parent.type === 'COMPONENT_SET' ? node.parent.id : undefined
    });
  }

  if ('children' in node) {
    for (const child of node.children) {
      walk(child, node.id, nodes, components);
    }
  }
}

const nodes = [];
const components = [];
for (const child of figma.currentPage.children) {
  walk(child, figma.currentPage.id, nodes, components);
}

return {
  fileKey: typeof figma.fileKey === 'string' ? figma.fileKey : undefined,
  fileName: figma.root.name,
  pageId: figma.currentPage.id,
  pageName: figma.currentPage.name,
  selectionIds: figma.currentPage.selection.map((node) => node.id),
  nodes,
  components
};
`.trim();

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function unwrapTalkResult<T>(value: unknown): T {
  const record = asRecord(value);
  if (record && record.success === true && "result" in record) {
    return record.result as T;
  }
  return value as T;
}

function normalizeNode(input: unknown): FigmaNode | null {
  const record = asRecord(input);
  if (!record) {
    return null;
  }

  const id = asString(record.id);
  const type = asString(record.type);
  if (!id || !type) {
    return null;
  }

  const boundsRecord = asRecord(record.bounds);
  const bounds = boundsRecord
    ? {
        x: asNumber(boundsRecord.x) ?? 0,
        y: asNumber(boundsRecord.y) ?? 0,
        width: asNumber(boundsRecord.width) ?? 0,
        height: asNumber(boundsRecord.height) ?? 0
      }
    : undefined;

  return {
    id,
    name: asString(record.name) ?? "",
    type,
    parentId: asString(record.parentId),
    childIds: asStringArray(record.childIds),
    visible: typeof record.visible === "boolean" ? record.visible : undefined,
    locked: typeof record.locked === "boolean" ? record.locked : undefined,
    bounds,
    pluginData: {}
  };
}

function normalizeComponent(input: unknown): FigmaComponentSummary | null {
  const record = asRecord(input);
  if (!record) {
    return null;
  }

  const id = asString(record.id);
  const name = asString(record.name);
  if (!id || !name) {
    return null;
  }

  return {
    id,
    key: asString(record.key),
    name,
    nodeId: asString(record.nodeId),
    pageId: asString(record.pageId),
    pageName: asString(record.pageName),
    description: asString(record.description),
    componentSetId: asString(record.componentSetId)
  };
}

function collectNormalizedComponents(...sources: unknown[]): FigmaComponentSummary[] {
  const deduped = new Map<string, FigmaComponentSummary>();

  for (const source of sources) {
    if (!Array.isArray(source)) {
      continue;
    }

    for (const entry of source) {
      const component = normalizeComponent(entry);
      if (!component) {
        continue;
      }

      const key = component.id || component.key || `${component.name}:${component.nodeId ?? ""}`;
      const existing = deduped.get(key);
      if (!existing) {
        deduped.set(key, component);
        continue;
      }

      deduped.set(key, {
        ...existing,
        ...component,
        key: existing.key ?? component.key,
        nodeId: existing.nodeId ?? component.nodeId,
        pageId: existing.pageId ?? component.pageId,
        pageName: existing.pageName ?? component.pageName,
        description: existing.description ?? component.description,
        componentSetId: existing.componentSetId ?? component.componentSetId
      });
    }
  }

  return [...deduped.values()];
}

function normalizeVariable(input: unknown): FigmaVariable | null {
  const record = asRecord(input);
  if (!record) {
    return null;
  }

  const id = asString(record.id);
  const name = asString(record.name);
  const resolvedType = asString(record.resolvedType);
  if (!id || !name || !resolvedType) {
    return null;
  }

  return {
    id,
    name,
    collectionId: asString(record.collectionId),
    resolvedType,
    value: record.value
  };
}

export async function syncTalkToFigmaChannel(input: SyncTalkToFigmaChannelInput): Promise<{
  session: FigmaSession;
  snapshot: FigmaSnapshot;
}> {
  const client = input.client ?? new TalkToFigmaClient({ wsUrl: input.wsUrl });
  const sessionId = input.sessionId ?? `talk-to-figma:${input.channel}`;
  const timeoutMs = input.timeoutMs ?? 15000;

  const snapshotResult = await client.executeCommand({
    channel: input.channel,
    command: "execute_code",
    params: {
      code: TALK_TO_FIGMA_SYNC_CODE
    },
    wsUrl: input.wsUrl,
    timeoutMs
  });

  const variablesResult = await client.executeCommand({
    channel: input.channel,
    command: "get_variables",
    params: {},
    wsUrl: input.wsUrl,
    timeoutMs
  }).catch(() => null);

  const localComponentsResult = await client.executeCommand({
    channel: input.channel,
    command: "get_local_components",
    params: {},
    wsUrl: input.wsUrl,
    timeoutMs
  }).catch(() => null);

  const rawSnapshot = unwrapTalkResult<JsonRecord>(snapshotResult.result);
  const rawVariables = variablesResult ? unwrapTalkResult<unknown>(variablesResult.result) : [];
  const rawLocalComponents = localComponentsResult ? unwrapTalkResult<unknown>(localComponentsResult.result) : [];
  const localComponentsRecord = asRecord(rawLocalComponents);
  const localComponents = localComponentsRecord?.components;
  const mergedComponents = collectNormalizedComponents(
    Array.isArray(rawSnapshot.components) ? rawSnapshot.components : [],
    Array.isArray(localComponents) ? localComponents : []
  );

  const snapshot: FigmaSnapshot = {
    sessionId,
    fileKey: asString(rawSnapshot.fileKey),
    fileName: asString(rawSnapshot.fileName),
    pageId: asString(rawSnapshot.pageId),
    pageName: asString(rawSnapshot.pageName),
    selectionIds: asStringArray(rawSnapshot.selectionIds),
    nodes: Array.isArray(rawSnapshot.nodes)
      ? rawSnapshot.nodes.map(normalizeNode).filter((node): node is FigmaNode => Boolean(node))
      : [],
    components: mergedComponents,
    variables: Array.isArray(rawVariables)
      ? rawVariables.map(normalizeVariable).filter((variable): variable is FigmaVariable => Boolean(variable))
      : [],
    raw: {
      source: "talk-to-figma",
      channel: input.channel,
      wsUrl: input.wsUrl,
      snapshotCommandRequestId: snapshotResult.requestId,
      localComponentsCommandRequestId: localComponentsResult?.requestId
    }
  };

  const session = await input.store.registerSession({
    sessionId,
    fileKey: snapshot.fileKey,
    fileName: snapshot.fileName,
    pageId: snapshot.pageId,
    pageName: snapshot.pageName,
    selectionIds: snapshot.selectionIds,
    pluginVersion: "cursor-talk-to-figma",
    bridgeVersion: "talk-to-figma-sync",
    metadata: {
      source: "talk-to-figma",
      channel: input.channel,
      wsUrl: input.wsUrl
    }
  });

  const persistedSnapshot = await input.store.upsertSnapshot(snapshot);

  return {
    session,
    snapshot: persistedSnapshot
  };
}
