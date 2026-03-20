/**
 * Hybrid asset materialization — multi-strategy import with provenance tracking.
 *
 * Import strategy preference order:
 * 1. runtime — the component is in the same session, use local componentId
 * 2. published-key — a component key exists, use importComponentByKeyAsync
 * 3. desktop-panel — fall back to desktop OCR/drag insertion
 *
 * Each attempt is recorded in an ImportReport so callers can see exactly
 * what was tried and what succeeded.
 */

import { BridgeStore } from "./bridge-store.js";
import { insertFigmaAssetWithOptionalSync } from "./figma-assets-insert-orchestrator.js";
import {
  LibraryIndex,
  createEmptyImportReport,
  recordAttempt,
  type ImportReport,
  type ImportStrategy,
} from "./library-index.js";
import { executeTalkToFigmaSessionQueue } from "./talk-to-figma-queue.js";
import { ensureTalkToFigmaSession } from "./talk-to-figma-session.js";
import { createTraceContext, recordTrace, type TraceContext } from "./trace-store.js";
import type { TraceStore } from "./trace-store.js";

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
  /** Optional library index override (for testing). Falls back to store.getLibraryIndex(). */
  libraryIndex?: LibraryIndex;
  /** Trace store for observability. */
  traceStore?: TraceStore;
  /** Parent trace id for linking this flow as a child of a higher-level trace. */
  parentTraceId?: string;
};

/**
 * Determine whether a queue execution run actually succeeded based on
 * acknowledgement records.
 *
 * The audit requirement is that success must be based on actually succeeded
 * acknowledgements — NOT merely on `processedCount > 0`, because failed
 * executions still produce processed updates.
 */
function hasSucceededAcknowledgement(run: Awaited<ReturnType<typeof executeTalkToFigmaSessionQueue>>): boolean {
  return run.acknowledged.some(
    (record) => record.status === "succeeded"
  );
}

/**
 * Internal helper to execute a queue with optional tracing.
 * Wraps the caller's `executeQueue` function with inline trace emission
 * when traceStore + parentTraceId are provided.
 */
async function executeQueueMaybeTraced(
  executeQueue: typeof executeTalkToFigmaSessionQueue,
  opts: {
    store: BridgeStore;
    sessionId: string;
    wsUrl?: string;
    timeoutMs?: number;
    traceStore?: TraceStore;
    parentTraceId?: string;
  },
): Promise<Awaited<ReturnType<typeof executeTalkToFigmaSessionQueue>>> {
  if (!opts.traceStore) {
    return executeQueue({
      store: opts.store,
      sessionId: opts.sessionId,
      wsUrl: opts.wsUrl,
      timeoutMs: opts.timeoutMs,
    });
  }

  // Wrap the caller's executeQueue with inline trace emission
  const traceCtx = createTraceContext(opts.traceStore, opts.parentTraceId);
  const traceStartedAt = new Date().toISOString();

  try {
    const result = await executeQueue({
      store: opts.store,
      sessionId: opts.sessionId,
      wsUrl: opts.wsUrl,
      timeoutMs: opts.timeoutMs,
      traceStore: opts.traceStore,
      parentTraceId: opts.parentTraceId,
    } as Parameters<typeof executeTalkToFigmaSessionQueue>[0]);

    if (traceCtx) {
      const batches = (result as { batches?: Array<{ batchId: string; status: string; failedOperationId?: string; failureMessage?: string }> }).batches ?? [];
      const failedBatches = batches.filter((b) => b.status !== "succeeded");
      const warnings = failedBatches
        .filter((b) => b.status === "partially_failed")
        .map((b) => `Batch ${b.batchId} partially failed at operation ${b.failedOperationId ?? "unknown"}`);
      const errors = failedBatches
        .filter((b) => b.status === "fully_failed")
        .map((b) => `Batch ${b.batchId} fully failed: ${b.failureMessage ?? "unknown"}`);

      recordTrace(traceCtx, {
        flowType: "queue-execution",
        startedAt: traceStartedAt,
        status: errors.length > 0 ? "failed" : "succeeded",
        sessionId: result.sessionId,
        channel: (result as { channel?: string }).channel,
        input: { sessionId: opts.sessionId },
        output: {
          processedCount: result.processedCount,
          batchCount: batches.length,
          snapshotSynced: result.snapshotSynced,
        },
        warnings,
        errors,
      });
    }

    return result;
  } catch (error) {
    if (traceCtx) {
      recordTrace(traceCtx, {
        flowType: "queue-execution",
        startedAt: traceStartedAt,
        status: "failed",
        sessionId: opts.sessionId,
        input: { sessionId: opts.sessionId },
        output: {},
        errors: [String(error)],
      });
    }
    throw error;
  }
}

export async function materializeFigmaAsset(input: MaterializeFigmaAssetInput): Promise<{
  ensured: Awaited<ReturnType<typeof ensureTalkToFigmaSession>>;
  inserted: Awaited<ReturnType<typeof insertFigmaAssetWithOptionalSync>>;
  selectedNodeIds: string[];
  selectionRun?: Awaited<ReturnType<typeof executeTalkToFigmaSessionQueue>>;
  importReport: ImportReport;
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
    forceLaunch: input.forceLaunch,
    traceStore: input.traceStore,
    parentTraceId: input.parentTraceId,
  });

  const report = createEmptyImportReport();

  // ── Strategy 1 & 2: try runtime / published-key via library index ────────
  const libraryIndex = input.libraryIndex ?? await input.store.getLibraryIndex();
  const indexResults = libraryIndex.search(input.query, 1);
  const indexEntry = indexResults[0];

  if (indexEntry) {
    report.indexHit = true;
    report.componentKey = indexEntry.key;
    report.componentId = indexEntry.componentId;

    const strategies = libraryIndex.rankStrategies(indexEntry, ensured.session.sessionId);

    for (const strategy of strategies) {
      if (strategy === "desktop-panel") {
        // Desktop panel is handled below as the final fallback.
        break;
      }

      // ── dryRun guard ──────────────────────────────────────────────────
      // When dryRun is true, deterministic strategies must not enqueue or
      // execute any document-mutating operations.
      if (input.dryRun) {
        recordAttempt(report, strategy, true, 0);
        return buildDryRunResult(input, ensured, report);
      }

      if (strategy === "runtime" && indexEntry.componentId) {
        const startTime = Date.now();
        try {
          await input.store.enqueueOperations({
            sessionId: ensured.session.sessionId,
            description: `Runtime create_instance: ${input.query}`,
            operations: [{
              type: "create_instance" as const,
              componentId: indexEntry.componentId,
            }],
          });

          const run = await executeQueueMaybeTraced(executeQueue, {
            store: input.store,
            sessionId: ensured.session.sessionId,
            wsUrl: ensured.wsUrl,
            timeoutMs: input.timeoutMs,
            traceStore: input.traceStore,
            parentTraceId: input.parentTraceId,
          });

          const succeeded = hasSucceededAcknowledgement(run);
          recordAttempt(report, "runtime", succeeded, Date.now() - startTime);

          if (succeeded) {
            return buildResult(input, ensured, report, run);
          }
        } catch (error) {
          recordAttempt(report, "runtime", false, Date.now() - startTime, String(error));
        }
      }

      if (strategy === "published-key" && indexEntry.key) {
        const startTime = Date.now();
        try {
          await input.store.enqueueOperations({
            sessionId: ensured.session.sessionId,
            description: `Published-key create_instance: ${input.query}`,
            operations: [{
              type: "create_instance" as const,
              componentKey: indexEntry.key,
            }],
          });

          const run = await executeQueueMaybeTraced(executeQueue, {
            store: input.store,
            sessionId: ensured.session.sessionId,
            wsUrl: ensured.wsUrl,
            timeoutMs: input.timeoutMs,
            traceStore: input.traceStore,
            parentTraceId: input.parentTraceId,
          });

          const succeeded = hasSucceededAcknowledgement(run);
          recordAttempt(report, "published-key", succeeded, Date.now() - startTime);

          if (succeeded) {
            return buildResult(input, ensured, report, run);
          }
        } catch (error) {
          recordAttempt(report, "published-key", false, Date.now() - startTime, String(error));
        }
      }
    }
  }

  // ── Strategy 3: desktop panel fallback ───────────────────────────────────
  const desktopStartTime = Date.now();
  try {
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
      postInsertDelayMs: input.postInsertDelayMs,
    });

    const succeeded = inserted.inserted;
    recordAttempt(report, "desktop-panel", succeeded, Date.now() - desktopStartTime);

    const selectedNodeIds = inserted.sync?.insertedNodes.map((node) => node.id) ?? [];
    if (input.dryRun || input.selectInsertedNodes === false || selectedNodeIds.length === 0) {
      return {
        ensured,
        inserted,
        selectedNodeIds,
        importReport: report,
      };
    }

    await input.store.enqueueOperations({
      sessionId: ensured.session.sessionId,
      description: `Select inserted asset: ${input.query}`,
      operations: [{
        type: "set_selection",
        selectionIds: selectedNodeIds,
      }],
    });

    const selectionRun = await executeQueueMaybeTraced(executeQueue, {
      store: input.store,
      sessionId: ensured.session.sessionId,
      wsUrl: ensured.wsUrl,
      timeoutMs: input.timeoutMs,
      traceStore: input.traceStore,
      parentTraceId: input.parentTraceId,
    });

    return {
      ensured,
      inserted,
      selectedNodeIds,
      selectionRun,
      importReport: report,
    };
  } catch (error) {
    recordAttempt(report, "desktop-panel", false, Date.now() - desktopStartTime, String(error));
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a dry-run result for deterministic strategies.
 * No document-mutating operations are enqueued or executed.
 */
function buildDryRunResult(
  input: MaterializeFigmaAssetInput,
  ensured: Awaited<ReturnType<typeof ensureTalkToFigmaSession>>,
  report: ImportReport,
): {
  ensured: Awaited<ReturnType<typeof ensureTalkToFigmaSession>>;
  inserted: Awaited<ReturnType<typeof insertFigmaAssetWithOptionalSync>>;
  selectedNodeIds: string[];
  importReport: ImportReport;
} {
  const inserted = {
    query: input.query,
    resultIndex: 0,
    dryRun: true,
    inserted: false,
    window: { x: 0, y: 0, w: 0, h: 0 },
    match: {
      text: input.query,
      normalizedText: input.query,
      canonicalText: input.query.toLowerCase(),
    },
    from: { x: 0, y: 0 },
    to: { x: 0, y: 0 },
  } as Awaited<ReturnType<typeof insertFigmaAssetWithOptionalSync>>;

  return {
    ensured,
    inserted,
    selectedNodeIds: [],
    importReport: report,
  };
}

async function buildResult(
  input: MaterializeFigmaAssetInput,
  ensured: Awaited<ReturnType<typeof ensureTalkToFigmaSession>>,
  report: ImportReport,
  run: Awaited<ReturnType<typeof executeTalkToFigmaSessionQueue>>,
): Promise<{
  ensured: Awaited<ReturnType<typeof ensureTalkToFigmaSession>>;
  inserted: Awaited<ReturnType<typeof insertFigmaAssetWithOptionalSync>>;
  selectedNodeIds: string[];
  selectionRun?: Awaited<ReturnType<typeof executeTalkToFigmaSessionQueue>>;
  importReport: ImportReport;
}> {
  const executeQueue = input.executeQueue ?? executeTalkToFigmaSessionQueue;

  // Build a synthetic "inserted" result that mirrors the desktop shape
  // but reflects the runtime strategy outcome.
  const inserted = {
    query: input.query,
    resultIndex: 0,
    dryRun: false,
    inserted: true,
    window: { x: 0, y: 0, w: 0, h: 0 },
    match: {
      text: input.query,
      normalizedText: input.query,
      canonicalText: input.query.toLowerCase(),
    },
    from: { x: 0, y: 0 },
    to: { x: 0, y: 0 },
  } as Awaited<ReturnType<typeof insertFigmaAssetWithOptionalSync>>;

  // If there are acknowledged operations with touched node ids, select them.
  const touchedNodeIds = run.acknowledged
    .filter((record) => record.status === "succeeded")
    .flatMap((record) => record.touchedNodeIds ?? [])
    .filter((id) => id.length > 0);

  if (input.selectInsertedNodes !== false && touchedNodeIds.length > 0) {
    await input.store.enqueueOperations({
      sessionId: ensured.session.sessionId,
      description: `Select inserted asset: ${input.query}`,
      operations: [{
        type: "set_selection",
        selectionIds: touchedNodeIds,
      }],
    });

    const selectionRun = await executeQueueMaybeTraced(executeQueue, {
      store: input.store,
      sessionId: ensured.session.sessionId,
      wsUrl: ensured.wsUrl,
      timeoutMs: input.timeoutMs,
      traceStore: input.traceStore,
      parentTraceId: input.parentTraceId,
    });

    return {
      ensured,
      inserted,
      selectedNodeIds: touchedNodeIds,
      selectionRun,
      importReport: report,
    };
  }

  return {
    ensured,
    inserted,
    selectedNodeIds: touchedNodeIds,
    importReport: report,
  };
}

// ---------------------------------------------------------------------------
// Traced wrapper
// ---------------------------------------------------------------------------

/**
 * Wrapper that instruments materializeFigmaAsset with tracing.
 *
 * Trace ownership model:
 * - Creates ONE top-level trace context (the materialize-asset trace).
 * - Passes its traceId as `parentTraceId` to the underlying
 *   `materializeFigmaAsset()`, which forwards it to all child flows
 *   (ensure-session, queue-execution).
 * - The result is a tree: materialize → ensure-session + queue-execution(s).
 */
export async function materializeFigmaAssetTraced(input: MaterializeFigmaAssetInput): Promise<ReturnType<typeof materializeFigmaAsset> extends Promise<infer R> ? R : never> {
  const traceCtx = createTraceContext(input.traceStore);
  const traceStartedAt = new Date().toISOString();

  // Override parentTraceId so all children link to this materialize trace.
  const childInput: MaterializeFigmaAssetInput = {
    ...input,
    parentTraceId: traceCtx?.traceId,
  };

  try {
    const result = await materializeFigmaAsset(childInput);

    if (traceCtx) {
      const succeededStrategy = result.importReport.attempts
        .find((a) => a.success)?.strategy ?? "none";
      const attemptSummary = result.importReport.attempts
        .map((a) => `${a.strategy}: ${a.success ? "ok" : "fail"} (${a.durationMs}ms)`)
        .join(", ");

      const warnings = result.importReport.attempts
        .filter((a) => !a.success && !a.error)
        .map((a) => `${a.strategy} failed without error`);
      const errors = result.importReport.attempts
        .filter((a) => !a.success && a.error)
        .map((a) => `${a.strategy}: ${a.error!}`);

      recordTrace(traceCtx, {
        flowType: "materialize-asset",
        startedAt: traceStartedAt,
        status: "succeeded",
        sessionId: result.ensured.session.sessionId,
        channel: result.ensured.channel,
        input: {
          query: input.query,
          dryRun: input.dryRun,
          indexHit: result.importReport.indexHit,
        },
        output: {
          succeededStrategy,
          attemptSummary,
          selectedNodeIds: result.selectedNodeIds,
          componentKey: result.importReport.componentKey,
          componentId: result.importReport.componentId,
        },
        warnings,
        errors,
      });
    }

    return result;
  } catch (error) {
    if (traceCtx) {
      recordTrace(traceCtx, {
        flowType: "materialize-asset",
        startedAt: traceStartedAt,
        status: "failed",
        input: {
          query: input.query,
          dryRun: input.dryRun,
        },
        output: {},
        errors: [String(error)],
      });
    }
    throw error;
  }
}
