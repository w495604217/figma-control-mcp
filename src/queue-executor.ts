import type { FigmaOperationRecord } from "./schemas.js";
import { executeOperation, type ExecutorAdapter } from "./operation-executor.js";

type JsonRecord = Record<string, unknown>;

export type OperationUpdate = {
  operationId: string;
  status: "dispatched" | "succeeded" | "failed";
  error?: string;
  result?: JsonRecord;
  touchedNodeIds: string[];
};

type MaybePromise<T> = T | Promise<T>;

export type UndoController = {
  commitUndo?: () => MaybePromise<void>;
  triggerUndo?: () => MaybePromise<void>;
};

type BatchExecutionResult = {
  updates: OperationUpdate[];
  processedCount: number;
};

function getBatchKey(record: FigmaOperationRecord): string {
  return record.batchId ?? record.operationId;
}

export function groupOperationsByBatch(records: FigmaOperationRecord[]): FigmaOperationRecord[][] {
  const groups: FigmaOperationRecord[][] = [];

  for (const record of records) {
    const previous = groups.length > 0 ? groups[groups.length - 1] : undefined;
    if (!previous || getBatchKey(previous[0]!) !== getBatchKey(record)) {
      groups.push([record]);
      continue;
    }

    previous.push(record);
  }

  return groups;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function executeQueuedOperations(
  adapter: ExecutorAdapter,
  records: FigmaOperationRecord[],
  undoController: UndoController = {}
): Promise<BatchExecutionResult> {
  const updates: OperationUpdate[] = [];

  for (const batch of groupOperationsByBatch(records)) {
    const batchKey = getBatchKey(batch[0]!);
    const succeeded = new Map<string, OperationUpdate>();
    let failedOperationId: string | undefined;
    let failureMessage: string | undefined;

    try {
      for (const record of batch) {
        failedOperationId = record.operationId;
        const execution = await executeOperation(adapter, record.operation);
        succeeded.set(record.operationId, {
          operationId: record.operationId,
          status: "succeeded",
          touchedNodeIds: execution.touchedNodeIds,
          result: execution.result
        });
      }

      await undoController.commitUndo?.();
      updates.push(...batch.map((record) => succeeded.get(record.operationId)!));
      continue;
    } catch (error) {
      failureMessage = formatError(error);
    }

    let rollbackMessage = `Batch ${batchKey} failed`;
    if (failedOperationId) {
      rollbackMessage += ` at operation ${failedOperationId}`;
    }
    rollbackMessage += `: ${failureMessage ?? "Unknown error"}`;

    try {
      await undoController.triggerUndo?.();
      rollbackMessage += " (changes rolled back)";
    } catch (rollbackError) {
      rollbackMessage += ` (rollback failed: ${formatError(rollbackError)})`;
    }

    for (const record of batch) {
      const priorSuccess = succeeded.get(record.operationId);
      const wasAttempted = Boolean(priorSuccess) || record.operationId === failedOperationId;
      updates.push({
        operationId: record.operationId,
        status: "failed",
        error: wasAttempted ? rollbackMessage : `${rollbackMessage} (not executed)`,
        touchedNodeIds: [],
        result: {
          batchId: batch[0]?.batchId ?? null,
          failedOperationId: failedOperationId ?? null,
          rolledBack: true
        }
      });
    }
  }

  return {
    updates,
    processedCount: updates.length
  };
}
