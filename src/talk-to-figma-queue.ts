import { BridgeStore } from "./bridge-store.js";
import { executeQueuedOperations } from "./queue-executor.js";
import { TalkToFigmaAdapter } from "./talk-to-figma-adapter.js";
import { syncTalkToFigmaChannel } from "./talk-to-figma-sync.js";
import { TalkToFigmaClient } from "./talk-to-figma.js";

type TalkToFigmaExecutor = Pick<TalkToFigmaClient, "executeCommand">;

type ExecuteTalkToFigmaQueueInput = {
  store: BridgeStore;
  sessionId: string;
  limit?: number;
  wsUrl?: string;
  timeoutMs?: number;
  syncAfter?: boolean;
  client?: TalkToFigmaExecutor;
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
  pulledCount: number;
  processedCount: number;
  updates: Array<{
    operationId: string;
    status: "dispatched" | "succeeded" | "failed";
    error?: string;
    result?: JsonRecord;
    touchedNodeIds: string[];
  }>;
  acknowledged: Array<{
    operationId: string;
    status: "queued" | "dispatched" | "succeeded" | "failed";
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

  const records = await input.store.pullQueuedOperations(input.sessionId, limit);
  if (records.length === 0) {
    return {
      sessionId: input.sessionId,
      channel,
      pulledCount: 0,
      processedCount: 0,
      updates: [],
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

  return {
    sessionId: input.sessionId,
    channel,
    pulledCount: records.length,
    processedCount: execution.processedCount,
    updates: execution.updates,
    acknowledged,
    snapshotSynced
  };
}
