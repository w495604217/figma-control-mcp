import { BridgeStore } from "./bridge-store.js";
import { executeQueuedOperations, type BatchOutcome } from "./queue-executor.js";
import { TalkToFigmaAdapter } from "./talk-to-figma-adapter.js";
import { assessSessionHealth, type SessionHealth } from "./talk-to-figma-session.js";
import { syncTalkToFigmaChannel } from "./talk-to-figma-sync.js";
import { TalkToFigmaClient } from "./talk-to-figma.js";
import { createTraceContext, recordTrace } from "./trace-store.js";
import type { TraceStore } from "./trace-store.js";

type TalkToFigmaExecutor = Pick<TalkToFigmaClient, "executeCommand">;

type ExecuteTalkToFigmaQueueInput = {
  store: BridgeStore;
  sessionId: string;
  limit?: number;
  wsUrl?: string;
  timeoutMs?: number;
  syncAfter?: boolean;
  client?: TalkToFigmaExecutor;
  /** Trace store for observability. When provided, a trace record is emitted. */
  traceStore?: TraceStore;
  /** Parent trace id for linking sub-operations. */
  parentTraceId?: string;
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function deriveTalkChannel(sessionId: string, metadata: Record<string, unknown>): string | undefined {
  if (typeof metadata.channel === "string" && metadata.channel) {
    return metadata.channel;
  }
  if (sessionId.startsWith("talk-to-figma:")) {
    return sessionId.slice("talk-to-figma:".length);
  }
  return undefined;
}

function deriveWsUrl(metadata: Record<string, unknown>, override?: string): string | undefined {
  if (override) {
    return override;
  }
  return typeof metadata.wsUrl === "string" ? metadata.wsUrl : undefined;
}

async function runUndoCommand(client: TalkToFigmaExecutor, options: {
  channel: string;
  wsUrl?: string;
  timeoutMs: number;
  expression: string;
}): Promise<void> {
  await client.executeCommand({
    channel: options.channel,
    command: "execute_code",
    params: {
      code: `${options.expression}; return { success: true };`
    },
    wsUrl: options.wsUrl,
    timeoutMs: options.timeoutMs
  });
}

export async function executeTalkToFigmaSessionQueue(input: ExecuteTalkToFigmaQueueInput): Promise<{
  sessionId: string;
  channel: string;
  sessionHealth: SessionHealth;
  pulledCount: number;
  processedCount: number;
  updates: Array<{
    operationId: string;
    status: "dispatched" | "succeeded" | "failed" | "skipped";
    error?: string;
    result?: JsonRecord;
    touchedNodeIds: string[];
  }>;
  batches: BatchOutcome[];
  acknowledged: Array<{
    operationId: string;
    status: "queued" | "dispatched" | "succeeded" | "failed" | "skipped";
    error?: string;
    result?: JsonRecord;
    touchedNodeIds: string[];
  }>;
  snapshotSynced: boolean;
}> {
  const session = await input.store.getSession(input.sessionId);
  if (!session) {
    throw new Error(`Session ${input.sessionId} was not found`);
  }

  const metadata = asRecord(session.metadata) ?? {};
  const source = typeof metadata.source === "string" ? metadata.source : undefined;
  if (source !== "talk-to-figma") {
    throw new Error(`Session ${input.sessionId} is not a talk-to-figma-backed session`);
  }

  const channel = deriveTalkChannel(session.sessionId, metadata);
  if (!channel) {
    throw new Error(`Session ${input.sessionId} does not contain a talk-to-figma channel`);
  }

  const wsUrl = deriveWsUrl(metadata, input.wsUrl);
  const timeoutMs = input.timeoutMs ?? 30000;
  const limit = input.limit ?? 20;
  const client = input.client ?? new TalkToFigmaClient({ wsUrl });

  // Pre-execution health snapshot (used as fallback if no post-sync re-assessment)
  const healthAssessment = assessSessionHealth(session, 5 * 60 * 1000);
  const preExecHealth: SessionHealth = healthAssessment.health;

  const records = await input.store.pullQueuedOperations(input.sessionId, limit);
  if (records.length === 0) {
    return {
      sessionId: input.sessionId,
      channel,
      sessionHealth: preExecHealth,
      pulledCount: 0,
      processedCount: 0,
      updates: [],
      batches: [],
      acknowledged: [],
      snapshotSynced: false
    };
  }

  const adapter = new TalkToFigmaAdapter({
    channel,
    wsUrl,
    timeoutMs,
    client
  });

  const execution = await executeQueuedOperations(adapter, records, {
    commitUndo: async () => {
      await runUndoCommand(client, {
        channel,
        wsUrl,
        timeoutMs,
        expression: "figma.commitUndo()"
      });
    },
    triggerUndo: async () => {
      await runUndoCommand(client, {
        channel,
        wsUrl,
        timeoutMs,
        expression: "figma.triggerUndo()"
      });
    }
  });

  const acknowledged = await input.store.acknowledgeOperations({
    sessionId: input.sessionId,
    updates: execution.updates
  });

  let snapshotSynced = false;
  if ((input.syncAfter ?? true) && execution.processedCount > 0) {
    await syncTalkToFigmaChannel({
      store: input.store,
      channel,
      sessionId: input.sessionId,
      wsUrl,
      timeoutMs,
      client
    });
    snapshotSynced = true;
  }

  // Post-execution health: re-read session to pick up any heartbeat/sync
  // updates made during execution, so callers see "active" after a
  // successful run instead of a possibly stale pre-execution assessment.
  let sessionHealth: SessionHealth;
  if (snapshotSynced) {
    const freshSession = await input.store.getSession(input.sessionId);
    if (freshSession) {
      sessionHealth = assessSessionHealth(freshSession, 5 * 60 * 1000).health;
    } else {
      sessionHealth = preExecHealth;
    }
  } else {
    sessionHealth = preExecHealth;
  }

  return {
    sessionId: input.sessionId,
    channel,
    sessionHealth,
    pulledCount: records.length,
    processedCount: execution.processedCount,
    updates: execution.updates,
    batches: execution.batches,
    acknowledged,
    snapshotSynced
  };
}

/**
 * Wrapper that instruments queue execution with tracing.
 */
export async function executeTalkToFigmaSessionQueueTraced(input: ExecuteTalkToFigmaQueueInput): Promise<ReturnType<typeof executeTalkToFigmaSessionQueue> extends Promise<infer R> ? R : never> {
  const traceCtx = createTraceContext(input.traceStore, input.parentTraceId);
  const traceStartedAt = new Date().toISOString();

  try {
    const result = await executeTalkToFigmaSessionQueue(input);

    if (traceCtx) {
      const failedBatches = result.batches.filter((b) => b.status !== "succeeded");
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
        channel: result.channel,
        input: {
          sessionId: input.sessionId,
          limit: input.limit,
          syncAfter: input.syncAfter,
        },
        output: {
          pulledCount: result.pulledCount,
          processedCount: result.processedCount,
          batchCount: result.batches.length,
          sessionHealth: result.sessionHealth,
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
        sessionId: input.sessionId,
        input: {
          sessionId: input.sessionId,
          limit: input.limit,
        },
        output: {},
        errors: [String(error)],
      });
    }
    throw error;
  }
}
