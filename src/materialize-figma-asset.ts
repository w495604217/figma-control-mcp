import { BridgeStore } from "./bridge-store.js";
import { insertFigmaAssetWithOptionalSync } from "./figma-assets-insert-orchestrator.js";
import { executeTalkToFigmaSessionQueue } from "./talk-to-figma-queue.js";
import { ensureTalkToFigmaSession } from "./talk-to-figma-session.js";

type MaterializeFigmaAssetInput = {
  store: BridgeStore;
  query: string;
  sessionId?: string;
  channel?: string;
  wsUrl?: string;
  logPath?: string;
  timeoutMs?: number;
  limit?: number;
  pluginName?: string;
  appName?: string;
  attempts?: number;
  delayMs?: number;
  forceLaunch?: boolean;
  activateApp?: boolean;
  windowTitle?: string;
  resultIndex?: number;
  settleMs?: number;
  holdMs?: number;
  releaseMs?: number;
  dryRun?: boolean;
  postInsertDelayMs?: number;
  selectInsertedNodes?: boolean;
  ensureSession?: typeof ensureTalkToFigmaSession;
  insertAsset?: typeof insertFigmaAssetWithOptionalSync;
  executeQueue?: typeof executeTalkToFigmaSessionQueue;
};

export async function materializeFigmaAsset(input: MaterializeFigmaAssetInput): Promise<{
  ensured: Awaited<ReturnType<typeof ensureTalkToFigmaSession>>;
  inserted: Awaited<ReturnType<typeof insertFigmaAssetWithOptionalSync>>;
  selectedNodeIds: string[];
  selectionRun?: Awaited<ReturnType<typeof executeTalkToFigmaSessionQueue>>;
}> {
  const ensureSession = input.ensureSession ?? ensureTalkToFigmaSession;
  const insertAsset = input.insertAsset ?? insertFigmaAssetWithOptionalSync;
  const executeQueue = input.executeQueue ?? executeTalkToFigmaSessionQueue;

  const ensured = await ensureSession({
    store: input.store,
    sessionId: input.sessionId,
    channel: input.channel,
    wsUrl: input.wsUrl,
    logPath: input.logPath,
    timeoutMs: input.timeoutMs,
    limit: input.limit,
    pluginName: input.pluginName,
    appName: input.appName,
    attempts: input.attempts,
    delayMs: input.delayMs,
    forceLaunch: input.forceLaunch
  });

  const inserted = await insertAsset({
    store: input.store,
    query: input.query,
    activateApp: input.activateApp,
    windowTitle: input.windowTitle,
    resultIndex: input.resultIndex,
    limit: input.limit,
    settleMs: input.settleMs,
    holdMs: input.holdMs,
    releaseMs: input.releaseMs,
    dryRun: input.dryRun,
    syncSessionId: ensured.session.sessionId,
    syncWsUrl: ensured.wsUrl,
    syncTimeoutMs: input.timeoutMs,
    postInsertDelayMs: input.postInsertDelayMs
  });

  const selectedNodeIds = inserted.sync?.insertedNodes.map((node) => node.id) ?? [];
  if (input.dryRun || input.selectInsertedNodes === false || selectedNodeIds.length === 0) {
    return {
      ensured,
      inserted,
      selectedNodeIds
    };
  }

  await input.store.enqueueOperations({
    sessionId: ensured.session.sessionId,
    description: `Select inserted asset: ${input.query}`,
    operations: [
      {
        type: "set_selection",
        selectionIds: selectedNodeIds
      }
    ]
  });

  const selectionRun = await executeQueue({
    store: input.store,
    sessionId: ensured.session.sessionId,
    wsUrl: ensured.wsUrl,
    timeoutMs: input.timeoutMs
  });

  return {
    ensured,
    inserted,
    selectedNodeIds,
    selectionRun
  };
}
