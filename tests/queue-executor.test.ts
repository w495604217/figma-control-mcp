import { describe, expect, it, vi } from "vitest";

import type { FigmaOperationRecord } from "../src/schemas.js";
import { executeQueuedOperations, groupOperationsByBatch } from "../src/queue-executor.js";
import type { ExecutorAdapter } from "../src/operation-executor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRecord(
  overrides: Partial<FigmaOperationRecord> & Pick<FigmaOperationRecord, "operationId" | "sessionId" | "operation">
): FigmaOperationRecord {
  return {
    operationId: overrides.operationId,
    batchId: overrides.batchId,
    sessionId: overrides.sessionId,
    status: overrides.status ?? "dispatched",
    operation: overrides.operation,
    createdAt: overrides.createdAt ?? "2026-03-20T00:00:00.000Z",
    touchedNodeIds: overrides.touchedNodeIds ?? []
  };
}

function createAdapter(): ExecutorAdapter {
  return {
    createNode: vi.fn(async () => ({ touchedNodeIds: ["created"], result: { createdNodeId: "new-node" } })),
    createInstance: vi.fn(async () => ({ touchedNodeIds: ["instance"], result: { createdNodeId: "instance-node" } })),
    updateNode: vi.fn(async () => ({ touchedNodeIds: ["updated"] })),
    deleteNode: vi.fn(async () => ({ touchedNodeIds: ["deleted"] })),
    moveNode: vi.fn(async () => ({ touchedNodeIds: ["moved"] })),
    setSelection: vi.fn(async () => ({ touchedNodeIds: ["selected"] })),
    setVariable: vi.fn(async () => ({ touchedNodeIds: [] })),
    runPluginAction: vi.fn(async () => ({ touchedNodeIds: ["action"] }))
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("groupOperationsByBatch", () => {
  it("groups contiguous records by batch id", () => {
    const groups = groupOperationsByBatch([
      createRecord({
        operationId: "op-1",
        batchId: "batch-a",
        sessionId: "s1",
        operation: { type: "set_selection", selectionIds: ["1:1"] }
      }),
      createRecord({
        operationId: "op-2",
        batchId: "batch-a",
        sessionId: "s1",
        operation: { type: "set_selection", selectionIds: ["1:2"] }
      }),
      createRecord({
        operationId: "op-3",
        sessionId: "s1",
        operation: { type: "set_selection", selectionIds: ["1:3"] }
      })
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(2);
    expect(groups[1]).toHaveLength(1);
  });
});

describe("executeQueuedOperations — transaction semantics", () => {
  // -------------------------------------------------------------------------
  // 1. Fully successful multi-operation batch
  // -------------------------------------------------------------------------
  it("returns succeeded batch outcome for a fully successful batch", async () => {
    const adapter = createAdapter();
    const commitUndo = vi.fn();

    const result = await executeQueuedOperations(adapter, [
      createRecord({
        operationId: "op-1",
        batchId: "batch-ok",
        sessionId: "s1",
        operation: { type: "create_node", node: { type: "FRAME", name: "A" } }
      }),
      createRecord({
        operationId: "op-2",
        batchId: "batch-ok",
        sessionId: "s1",
        operation: { type: "set_selection", selectionIds: ["new-node"] }
      })
    ], { commitUndo });

    // Per-operation updates
    expect(result.updates).toHaveLength(2);
    expect(result.updates.every((u) => u.status === "succeeded")).toBe(true);
    expect(result.processedCount).toBe(2);
    expect(commitUndo).toHaveBeenCalledOnce();

    // Batch outcome
    expect(result.batches).toHaveLength(1);
    const batch = result.batches[0]!;
    expect(batch.status).toBe("succeeded");
    expect(batch.batchId).toBe("batch-ok");
    expect(batch.rollbackAttempted).toBe(false);
    expect(batch.rollbackSucceeded).toBeUndefined();
    expect(batch.succeededIds).toEqual(["op-1", "op-2"]);
    expect(batch.failedIds).toEqual([]);
    expect(batch.skippedIds).toEqual([]);
    expect(batch.failedOperationId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 2. Batch fails on first operation
  // -------------------------------------------------------------------------
  it("returns fully_failed when first operation throws", async () => {
    const adapter = createAdapter();
    (adapter.createNode as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Permission denied"));
    const triggerUndo = vi.fn();

    const result = await executeQueuedOperations(adapter, [
      createRecord({
        operationId: "op-1",
        batchId: "batch-fail",
        sessionId: "s1",
        operation: { type: "create_node", node: { type: "FRAME", name: "Fail" } }
      }),
      createRecord({
        operationId: "op-2",
        batchId: "batch-fail",
        sessionId: "s1",
        operation: { type: "set_selection", selectionIds: ["1:1"] }
      })
    ], { triggerUndo });

    // Batch level
    const batch = result.batches[0]!;
    expect(batch.status).toBe("fully_failed");
    expect(batch.failedOperationId).toBe("op-1");
    expect(batch.failureMessage).toBe("Permission denied");
    expect(batch.rollbackAttempted).toBe(true);
    expect(batch.rollbackSucceeded).toBe(true);
    expect(batch.succeededIds).toEqual([]);
    expect(batch.failedIds).toEqual(["op-1"]);
    expect(batch.skippedIds).toEqual(["op-2"]);

    // Per-operation: op-1 is "failed", op-2 is "skipped"
    expect(result.updates[0]?.status).toBe("failed");
    expect(result.updates[1]?.status).toBe("skipped");
  });

  // -------------------------------------------------------------------------
  // 3. Batch fails after one prior operation succeeded
  // -------------------------------------------------------------------------
  it("returns partially_failed when failure occurs after a success", async () => {
    const adapter = createAdapter();
    (adapter.updateNode as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Node locked"));
    const triggerUndo = vi.fn();

    const result = await executeQueuedOperations(adapter, [
      createRecord({
        operationId: "op-1",
        batchId: "batch-partial",
        sessionId: "s1",
        operation: { type: "create_node", node: { type: "FRAME", name: "OK" } }
      }),
      createRecord({
        operationId: "op-2",
        batchId: "batch-partial",
        sessionId: "s1",
        operation: { type: "update_node", nodeId: "1:1", patch: { name: "Locked" } }
      }),
      createRecord({
        operationId: "op-3",
        batchId: "batch-partial",
        sessionId: "s1",
        operation: { type: "set_selection", selectionIds: ["1:1"] }
      })
    ], { triggerUndo });

    const batch = result.batches[0]!;
    expect(batch.status).toBe("partially_failed");
    expect(batch.failedOperationId).toBe("op-2");
    expect(batch.succeededIds).toEqual(["op-1"]);
    expect(batch.failedIds).toContain("op-1"); // succeeded-then-rolled-back
    expect(batch.failedIds).toContain("op-2"); // the throwing operation
    expect(batch.skippedIds).toEqual(["op-3"]);

    // Per-operation three-state
    expect(result.updates[0]?.status).toBe("failed");   // attempted (rolled back)
    expect(result.updates[1]?.status).toBe("failed");   // the failure
    expect(result.updates[2]?.status).toBe("skipped");   // never executed
  });

  // -------------------------------------------------------------------------
  // 4. Rollback succeeds
  // -------------------------------------------------------------------------
  it("reports rollbackSucceeded = true when triggerUndo resolves", async () => {
    const adapter = createAdapter();
    (adapter.createNode as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Oops"));
    const triggerUndo = vi.fn();

    const result = await executeQueuedOperations(adapter, [
      createRecord({
        operationId: "op-1",
        batchId: "b-rb-ok",
        sessionId: "s1",
        operation: { type: "create_node", node: { type: "FRAME", name: "X" } }
      })
    ], { triggerUndo });

    const batch = result.batches[0]!;
    expect(batch.rollbackAttempted).toBe(true);
    expect(batch.rollbackSucceeded).toBe(true);
    expect(batch.rollbackError).toBeUndefined();
    expect(result.updates[0]?.error).toContain("rolled back");
  });

  // -------------------------------------------------------------------------
  // 5. Rollback fails
  // -------------------------------------------------------------------------
  it("reports rollbackSucceeded = false when triggerUndo throws", async () => {
    const adapter = createAdapter();
    (adapter.createNode as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Oops"));
    const triggerUndo = vi.fn().mockRejectedValueOnce(new Error("Undo channel disconnected"));

    const result = await executeQueuedOperations(adapter, [
      createRecord({
        operationId: "op-1",
        batchId: "b-rb-fail",
        sessionId: "s1",
        operation: { type: "create_node", node: { type: "FRAME", name: "X" } }
      })
    ], { triggerUndo });

    const batch = result.batches[0]!;
    expect(batch.rollbackAttempted).toBe(true);
    expect(batch.rollbackSucceeded).toBe(false);
    expect(batch.rollbackError).toBe("Undo channel disconnected");
    expect(result.updates[0]?.error).toContain("rollback failed");
  });

  // -------------------------------------------------------------------------
  // 6. Skipped operations are distinguishable
  // -------------------------------------------------------------------------
  it("marks never-executed operations with status skipped", async () => {
    const adapter = createAdapter();
    (adapter.createNode as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("fail"));

    const result = await executeQueuedOperations(adapter, [
      createRecord({
        operationId: "op-1",
        batchId: "batch-skip",
        sessionId: "s1",
        operation: { type: "create_node", node: { type: "FRAME", name: "X" } }
      }),
      createRecord({
        operationId: "op-2",
        batchId: "batch-skip",
        sessionId: "s1",
        operation: { type: "set_selection", selectionIds: ["1:1"] }
      }),
      createRecord({
        operationId: "op-3",
        batchId: "batch-skip",
        sessionId: "s1",
        operation: { type: "delete_node", nodeId: "1:2" }
      })
    ]);

    const statuses = result.updates.map((u) => u.status);
    expect(statuses).toEqual(["failed", "skipped", "skipped"]);

    // skipped operations include "(not executed)" in their error
    expect(result.updates[1]?.error).toContain("not executed");
    expect(result.updates[2]?.error).toContain("not executed");
    // failed operation does NOT include "(not executed)"
    expect(result.updates[0]?.error).not.toContain("not executed");
  });

  // -------------------------------------------------------------------------
  // 7. processedCount is unambiguous
  // -------------------------------------------------------------------------
  it("processedCount equals total update count including skipped", async () => {
    const adapter = createAdapter();
    (adapter.updateNode as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("locked"));

    const result = await executeQueuedOperations(adapter, [
      createRecord({
        operationId: "op-1",
        batchId: "batch-count",
        sessionId: "s1",
        operation: { type: "create_node", node: { type: "FRAME", name: "A" } }
      }),
      createRecord({
        operationId: "op-2",
        batchId: "batch-count",
        sessionId: "s1",
        operation: { type: "update_node", nodeId: "1:1", patch: { name: "B" } }
      }),
      createRecord({
        operationId: "op-3",
        batchId: "batch-count",
        sessionId: "s1",
        operation: { type: "set_selection", selectionIds: ["1:1"] }
      })
    ]);

    expect(result.processedCount).toBe(3);
    expect(result.updates).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // 8. Empty queue
  // -------------------------------------------------------------------------
  it("returns empty batches for empty records", async () => {
    const adapter = createAdapter();

    const result = await executeQueuedOperations(adapter, []);

    expect(result.updates).toEqual([]);
    expect(result.processedCount).toBe(0);
    expect(result.batches).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 9. Single-operation batch success
  // -------------------------------------------------------------------------
  it("handles single-operation batch success", async () => {
    const adapter = createAdapter();
    const commitUndo = vi.fn();

    const result = await executeQueuedOperations(adapter, [
      createRecord({
        operationId: "solo-op",
        sessionId: "s1",
        operation: { type: "create_node", node: { type: "TEXT", name: "Hello" } }
      })
    ], { commitUndo });

    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]?.status).toBe("succeeded");
    expect(result.batches[0]?.succeededIds).toEqual(["solo-op"]);
    expect(result.updates[0]?.status).toBe("succeeded");
    expect(commitUndo).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // 10. Single-operation batch failure
  // -------------------------------------------------------------------------
  it("handles single-operation batch failure", async () => {
    const adapter = createAdapter();
    (adapter.createNode as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    const triggerUndo = vi.fn();

    const result = await executeQueuedOperations(adapter, [
      createRecord({
        operationId: "solo-fail",
        sessionId: "s1",
        operation: { type: "create_node", node: { type: "FRAME", name: "X" } }
      })
    ], { triggerUndo });

    expect(result.batches).toHaveLength(1);
    const batch = result.batches[0]!;
    expect(batch.status).toBe("fully_failed");
    expect(batch.failedOperationId).toBe("solo-fail");
    expect(batch.failedIds).toEqual(["solo-fail"]);
    expect(batch.skippedIds).toEqual([]);
    expect(result.updates[0]?.status).toBe("failed");
    expect(triggerUndo).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // 11. Transaction metadata preserved in result objects
  // -------------------------------------------------------------------------
  it("includes rollback metadata in per-operation result objects", async () => {
    const adapter = createAdapter();
    (adapter.updateNode as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("locked"));

    const result = await executeQueuedOperations(adapter, [
      createRecord({
        operationId: "op-1",
        batchId: "batch-meta",
        sessionId: "s1",
        operation: { type: "create_node", node: { type: "FRAME", name: "A" } }
      }),
      createRecord({
        operationId: "op-2",
        batchId: "batch-meta",
        sessionId: "s1",
        operation: { type: "update_node", nodeId: "1:1", patch: { name: "B" } }
      })
    ]);

    // Both operations should carry rollback metadata in their result
    for (const update of result.updates) {
      expect(update.result).toBeDefined();
      expect((update.result as Record<string, unknown>).rollbackAttempted).toBe(true);
      expect((update.result as Record<string, unknown>).failedOperationId).toBe("op-2");
    }
  });
});
