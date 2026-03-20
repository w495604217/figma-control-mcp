import { describe, expect, it, vi } from "vitest";

import type { FigmaOperationRecord } from "../src/schemas.js";
import { executeQueuedOperations, groupOperationsByBatch } from "../plugin-example/src/batch-executor.js";
import type { ExecutorAdapter } from "../plugin-example/src/executor.js";

function createRecord(
  overrides: Partial<FigmaOperationRecord> & Pick<FigmaOperationRecord, "operationId" | "sessionId" | "operation">
): FigmaOperationRecord {
  return {
    operationId: overrides.operationId,
    batchId: overrides.batchId,
    sessionId: overrides.sessionId,
    status: overrides.status ?? "dispatched",
    operation: overrides.operation,
    createdAt: overrides.createdAt ?? "2026-03-17T00:00:00.000Z",
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

describe("groupOperationsByBatch", () => {
  it("groups contiguous records by batch id and falls back to operation id", () => {
    const groups = groupOperationsByBatch([
      createRecord({
        operationId: "op-1",
        batchId: "batch-a",
        sessionId: "session-1",
        operation: { type: "set_selection", selectionIds: ["1:1"] }
      }),
      createRecord({
        operationId: "op-2",
        batchId: "batch-a",
        sessionId: "session-1",
        operation: { type: "set_selection", selectionIds: ["1:2"] }
      }),
      createRecord({
        operationId: "op-3",
        sessionId: "session-1",
        operation: { type: "set_selection", selectionIds: ["1:3"] }
      })
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(2);
    expect(groups[1]).toHaveLength(1);
    expect(groups[1]?.[0]?.operationId).toBe("op-3");
  });
});

describe("executeQueuedOperations", () => {
  it("commits successful batches as a single undo step", async () => {
    const adapter = createAdapter();
    const commitUndo = vi.fn();
    const triggerUndo = vi.fn();

    const result = await executeQueuedOperations(adapter, [
      createRecord({
        operationId: "op-1",
        batchId: "batch-success",
        sessionId: "session-1",
        operation: { type: "create_node", node: { type: "FRAME", name: "Hero" } }
      }),
      createRecord({
        operationId: "op-2",
        batchId: "batch-success",
        sessionId: "session-1",
        operation: { type: "set_selection", selectionIds: ["new-node"] }
      })
    ], {
      commitUndo,
      triggerUndo
    });

    expect(result.processedCount).toBe(2);
    expect(result.updates.every((update) => update.status === "succeeded")).toBe(true);
    expect(commitUndo).toHaveBeenCalledOnce();
    expect(triggerUndo).not.toHaveBeenCalled();
  });

  it("rolls back the whole batch when one operation fails", async () => {
    const adapter = createAdapter();
    const failingAdapter: ExecutorAdapter = {
      ...adapter,
      updateNode: vi.fn(async () => {
        throw new Error("Node is locked");
      })
    };
    const commitUndo = vi.fn();
    const triggerUndo = vi.fn();

    const result = await executeQueuedOperations(failingAdapter, [
      createRecord({
        operationId: "op-1",
        batchId: "batch-fail",
        sessionId: "session-1",
        operation: { type: "create_node", node: { type: "FRAME", name: "Card" } }
      }),
      createRecord({
        operationId: "op-2",
        batchId: "batch-fail",
        sessionId: "session-1",
        operation: { type: "update_node", nodeId: "1:1", patch: { name: "Locked" } }
      }),
      createRecord({
        operationId: "op-3",
        batchId: "batch-fail",
        sessionId: "session-1",
        operation: { type: "set_selection", selectionIds: ["1:1"] }
      })
    ], {
      commitUndo,
      triggerUndo
    });

     expect(result.processedCount).toBe(3);
    expect(result.updates[0]?.status).toBe("failed");
    expect(result.updates[1]?.status).toBe("failed");
    expect(result.updates[2]?.status).toBe("skipped");
    expect(result.updates[0]?.error).toContain("rolled back");
    expect(result.updates[2]?.error).toContain("not executed");
    expect(commitUndo).not.toHaveBeenCalled();
    expect(triggerUndo).toHaveBeenCalledOnce();
  });
});
