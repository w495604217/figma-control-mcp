import { BridgeStore } from "./bridge-store.js";
import { canonicalizeFigmaAssetsText } from "./figma-assets-text.js";
import { insertFigmaAssetFromPanel, type FigmaAssetsSearchMatch } from "./figma-assets-workflow.js";
import { diffSnapshots, type FigmaSnapshotDelta } from "./snapshot-delta.js";
import type { FigmaNode, FigmaSession, FigmaSnapshot } from "./schemas.js";
import { TalkToFigmaClient } from "./talk-to-figma.js";
import { syncTalkToFigmaChannel } from "./talk-to-figma-sync.js";

type InsertAndSyncOptions = {
  store: BridgeStore;
  query: string;
  activateApp?: boolean;
  windowTitle?: string;
  resultIndex?: number;
  limit?: number;
  settleMs?: number;
  holdMs?: number;
  releaseMs?: number;
  dryRun?: boolean;
  syncSessionId?: string;
  syncWsUrl?: string;
  syncTimeoutMs?: number;
  postInsertDelayMs?: number;
};

type InsertSyncResult = {
  session: FigmaSession;
  snapshot: FigmaSnapshot;
  delta: FigmaSnapshotDelta;
  insertedNodes: FigmaNode[];
  channel: string;
};

export type InsertFigmaAssetWithSyncResult = Awaited<ReturnType<typeof insertFigmaAssetWithOptionalSync>>;

function resolveTalkChannel(sessionId: string, session: FigmaSession | null): string | undefined {
  const metadataChannel = typeof session?.metadata?.channel === "string" ? session.metadata.channel : undefined;
  if (metadataChannel) {
    return metadataChannel;
  }
  if (sessionId.startsWith("talk-to-figma:")) {
    return sessionId.slice("talk-to-figma:".length) || undefined;
  }
  return undefined;
}

function hasTalkSource(session: FigmaSession | null): boolean {
  return session?.metadata?.source === "talk-to-figma" || session?.sessionId.startsWith("talk-to-figma:") === true;
}

function findStrayInsertedTextNodes(nodes: FigmaNode[], query: string): FigmaNode[] {
  const canonicalQuery = canonicalizeFigmaAssetsText(query);
  return nodes.filter((node) =>
    node.type === "TEXT"
    && node.parentId === "0:1"
    && canonicalizeFigmaAssetsText(node.name).includes(canonicalQuery)
  );
}

function hasConcreteInsertedInstance(nodes: FigmaNode[]): boolean {
  return nodes.some((node) => node.type === "INSTANCE");
}

async function cleanupStrayInsertedTextNodes(input: {
  channel: string;
  wsUrl?: string;
  nodeIds: string[];
  timeoutMs?: number;
}): Promise<void> {
  if (input.nodeIds.length === 0) {
    return;
  }

  const client = new TalkToFigmaClient({
    wsUrl: input.wsUrl
  });
  const quotedIds = JSON.stringify(input.nodeIds);
  const code = `for (const id of ${quotedIds}) { const node = await figma.getNodeByIdAsync(id); if (node) node.remove(); } return { removed: ${quotedIds} };`;
  await client.executeCommand({
    channel: input.channel,
    wsUrl: input.wsUrl,
    command: "execute_code",
    params: { code },
    timeoutMs: input.timeoutMs ?? 15_000
  });
}

export async function insertFigmaAssetWithOptionalSync(input: InsertAndSyncOptions): Promise<{
  query: string;
  resultIndex: number;
  dryRun: boolean;
  inserted: boolean;
  image?: string;
  window: {
    id?: number;
    pid?: number;
    owner?: string;
    title?: string;
    x: number;
    y: number;
    w: number;
    h: number;
    layer?: number;
    alpha?: number;
    onscreen?: boolean;
    z_index?: number;
    source?: string;
    window_kind?: string;
    match_score?: number;
  };
  match: FigmaAssetsSearchMatch;
  from: {
    x: number;
    y: number;
  };
  to: {
    x: number;
    y: number;
  };
  sync?: InsertSyncResult;
}> {
  let beforeSnapshot: FigmaSnapshot | null = null;
  let syncSession: FigmaSession | null = null;

  if (input.syncSessionId) {
    beforeSnapshot = await input.store.getSnapshot(input.syncSessionId);
    syncSession = await input.store.getSession(input.syncSessionId);
  }

  const inserted = await insertFigmaAssetFromPanel(input);

  if (input.dryRun || !input.syncSessionId || !hasTalkSource(syncSession)) {
    return inserted;
  }

  const channel = resolveTalkChannel(input.syncSessionId, syncSession);
  if (!channel) {
    return inserted;
  }

  await new Promise((resolve) => setTimeout(resolve, input.postInsertDelayMs ?? 900));
  let synced = await syncTalkToFigmaChannel({
    store: input.store,
    sessionId: input.syncSessionId,
    channel,
    wsUrl: input.syncWsUrl ?? (typeof syncSession?.metadata?.wsUrl === "string" ? syncSession.metadata.wsUrl : undefined),
    timeoutMs: input.syncTimeoutMs
  });
  let delta = diffSnapshots(beforeSnapshot, synced.snapshot);
  const strayTextNodes = findStrayInsertedTextNodes(delta.addedNodes, input.query);

  if (strayTextNodes.length > 0 && hasConcreteInsertedInstance(delta.addedNodes)) {
    await cleanupStrayInsertedTextNodes({
      channel,
      wsUrl: input.syncWsUrl ?? (typeof syncSession?.metadata?.wsUrl === "string" ? syncSession.metadata.wsUrl : undefined),
      timeoutMs: input.syncTimeoutMs,
      nodeIds: strayTextNodes.map((node) => node.id)
    });

    await new Promise((resolve) => setTimeout(resolve, 240));
    synced = await syncTalkToFigmaChannel({
      store: input.store,
      sessionId: input.syncSessionId,
      channel,
      wsUrl: input.syncWsUrl ?? (typeof syncSession?.metadata?.wsUrl === "string" ? syncSession.metadata.wsUrl : undefined),
      timeoutMs: input.syncTimeoutMs
    });
    delta = diffSnapshots(beforeSnapshot, synced.snapshot);
  }

  return {
    ...inserted,
    sync: {
      session: synced.session,
      snapshot: synced.snapshot,
      delta,
      insertedNodes: delta.addedNodes,
      channel
    }
  };
}
