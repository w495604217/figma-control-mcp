import type { FigmaOperationRecord } from "./schemas.js";
import { executeOperation, type ExecutorAdapter } from "./operation-executor.js";

type JsonRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Operation-level result
// ---------------------------------------------------------------------------

export type OperationUpdate = {
  operationId: string;
  /**
   * - "dispatched" — sent to the runtime but no acknowledgement yet
   * - "succeeded" — confirmed success
   * - "failed"    — attempted but failed (or rolled back after a later failure)
   * - "skipped"   — never executed because a prior operation in the batch failed
   */
  status: "dispatched" | "succeeded" | "failed" | "skipped";
  error?: string;
  result?: JsonRecord;
  touchedNodeIds: string[];
};

// ---------------------------------------------------------------------------
// Batch-level transaction outcome
// ---------------------------------------------------------------------------

export type BatchOutcome = {
  /** Batch identifier (batchId or fallback operationId of the first record). */
  batchId: string;
  /**
   * - "succeeded"        — every operation in the batch completed
   * - "partially_failed" — at least one operation succeeded before the failure
   * - "fully_failed"     — the first operation failed (nothing completed)
   */
  status: "succeeded" | "partially_failed" | "fully_failed";
  /** ID of the operation that threw. Undefined on success. */
  failedOperationId?: string;
  /** Error message from the failed operation. */
  failureMessage?: string;
  /** Whether the system attempted to undo. Always false on success path. */
  rollbackAttempted: boolean;
  /** Whether triggerUndo resolved. Undefined when rollback was not attempted. */
  rollbackSucceeded?: boolean;
  /** Error message from triggerUndo when it fails. */
  rollbackError?: string;
  /** IDs of operations that completed successfully (may be empty after rollback). */
  succeededIds: string[];
  /** IDs of operations that were attempted but failed. */
  failedIds: string[];
  /** IDs of operations that were never executed. */
  skippedIds: string[];
};

// ---------------------------------------------------------------------------
// Undo controller
// ---------------------------------------------------------------------------

type MaybePromise<T> = T | Promise<T>;

export type UndoController = {
  commitUndo?: () => MaybePromise<void>;
  triggerUndo?: () => MaybePromise<void>;
};

// ---------------------------------------------------------------------------
// Batch execution result
// ---------------------------------------------------------------------------

export type BatchExecutionResult = {
  /** Per-operation updates (backwards compatible). */
  updates: OperationUpdate[];
  /** Total number of operation updates produced (backwards compatible). */
  processedCount: number;
  /** Structured transaction outcome per batch (Phase 3). */
  batches: BatchOutcome[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------

export async function executeQueuedOperations(
  adapter: ExecutorAdapter,
  records: FigmaOperationRecord[],
  undoController: UndoController = {}
): Promise<BatchExecutionResult> {
  const updates: OperationUpdate[] = [];
  const batches: BatchOutcome[] = [];

  for (const batch of groupOperationsByBatch(records)) {
    const batchKey = getBatchKey(batch[0]!);
    const succeeded = new Map<string, OperationUpdate>();
    let failedOperationId: string | undefined;
    let failureMessage: string | undefined;

    // -----------------------------------------------------------------------
    // Try executing every operation in the batch
    // -----------------------------------------------------------------------
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

      // All operations succeeded — commit the undo checkpoint
      await undoController.commitUndo?.();
      updates.push(...batch.map((record) => succeeded.get(record.operationId)!));

      batches.push({
        batchId: batchKey,
        status: "succeeded",
        rollbackAttempted: false,
        succeededIds: batch.map((r) => r.operationId),
        failedIds: [],
        skippedIds: [],
      });
      continue;
    } catch (error) {
      failureMessage = formatError(error);
    }

    // -----------------------------------------------------------------------
    // Failure path — attempt rollback
    // -----------------------------------------------------------------------
    const succeededBeforeFailure = [...succeeded.keys()];
    const batchStatus = succeededBeforeFailure.length > 0 ? "partially_failed" : "fully_failed";

    let rollbackSucceeded: boolean | undefined;
    let rollbackError: string | undefined;

    try {
      await undoController.triggerUndo?.();
      rollbackSucceeded = true;
    } catch (rbError) {
      rollbackSucceeded = false;
      rollbackError = formatError(rbError);
    }

    // Build per-operation updates with correct three-state distinction
    const errorBase = `Batch ${batchKey} failed at operation ${failedOperationId ?? "unknown"}: ${failureMessage ?? "Unknown error"}`;
    const rollbackSuffix = rollbackSucceeded
      ? " (changes rolled back)"
      : ` (rollback failed: ${rollbackError ?? "unknown"})`;
    const fullMessage = errorBase + rollbackSuffix;

    const failedIds: string[] = [];
    const skippedIds: string[] = [];

    for (const record of batch) {
      const wasSucceeded = succeeded.has(record.operationId);
      const wasTheFailure = record.operationId === failedOperationId;

      if (wasSucceeded || wasTheFailure) {
        // This operation was attempted (either succeeded-then-rolled-back or failed)
        failedIds.push(record.operationId);
        updates.push({
          operationId: record.operationId,
          status: "failed",
          error: fullMessage,
          touchedNodeIds: [],
          result: {
            batchId: batch[0]?.batchId ?? null,
            failedOperationId: failedOperationId ?? null,
            rollbackAttempted: true,
            rollbackSucceeded: rollbackSucceeded ?? false,
          }
        });
      } else {
        // This operation was never executed
        skippedIds.push(record.operationId);
        updates.push({
          operationId: record.operationId,
          status: "skipped",
          error: `${fullMessage} (not executed)`,
          touchedNodeIds: [],
          result: {
            batchId: batch[0]?.batchId ?? null,
            failedOperationId: failedOperationId ?? null,
            rollbackAttempted: true,
            rollbackSucceeded: rollbackSucceeded ?? false,
          }
        });
      }
    }

    batches.push({
      batchId: batchKey,
      status: batchStatus,
      failedOperationId,
      failureMessage,
      rollbackAttempted: true,
      rollbackSucceeded,
      rollbackError,
      succeededIds: succeededBeforeFailure,
      failedIds,
      skippedIds,
    });
  }

  return {
    updates,
    processedCount: updates.length,
    batches,
  };
}
