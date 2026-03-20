import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { BridgeStore } from "../src/bridge-store.js";

async function createStore() {
  const dir = await mkdtemp(join(tmpdir(), "figma-control-mcp-"));
  return new BridgeStore(join(dir, "bridge-state.json"));
}

describe("BridgeStore", () => {
  it("registers a session and persists it", async () => {
    const store = await createStore();
    const session = await store.registerSession({
      sessionId: "session-1",
      fileKey: "file-key",
      fileName: "Design System"
    });

    expect(session.sessionId).toBe("session-1");
    expect(session.fileKey).toBe("file-key");
    expect(session.connectedAt).toBeTruthy();
    expect(session.lastHeartbeatAt).toBeTruthy();
  });

  it("publishes a snapshot and surfaces it by session id", async () => {
    const store = await createStore();
    await store.registerSession({
      sessionId: "session-2"
    });

    await store.upsertSnapshot({
      sessionId: "session-2",
      fileName: "Landing Page",
      nodes: [
        {
          id: "1:2",
          name: "Hero",
          type: "FRAME",
          childIds: ["1:3"]
        }
      ],
      variables: [
        {
          id: "var-1",
          name: "Color / Primary",
          resolvedType: "COLOR"
        }
      ]
    });

    const snapshot = await store.getSnapshot("session-2");
    expect(snapshot?.fileName).toBe("Landing Page");
    expect(snapshot?.nodes).toHaveLength(1);
    expect(snapshot?.variables[0]?.name).toBe("Color / Primary");
  });

  it("queues, dispatches, and acknowledges operations", async () => {
    const store = await createStore();
    await store.registerSession({ sessionId: "session-3" });

    const queued = await store.enqueueOperations({
      sessionId: "session-3",
      description: "Create a CTA button",
      operations: [
        {
          type: "create_node",
          parentId: "1:2",
          node: {
            type: "FRAME",
            name: "CTA Button"
          }
        },
        {
          type: "set_selection",
          selectionIds: ["1:2"]
        }
      ]
    });

    expect(queued).toHaveLength(2);
    expect(queued[0]?.status).toBe("queued");
    expect(queued[0]?.batchId).toBeTruthy();
    expect(queued[0]?.batchId).toBe(queued[1]?.batchId);

    const dispatched = await store.pullQueuedOperations("session-3", 10);
    expect(dispatched).toHaveLength(2);
    expect(dispatched.every((record) => record.status === "dispatched")).toBe(true);

    const acked = await store.acknowledgeOperations({
      sessionId: "session-3",
      updates: [
        {
          operationId: dispatched[0]?.operationId,
          status: "succeeded",
          touchedNodeIds: ["9:1"],
          result: {
            createdNodeId: "9:1"
          }
        },
        {
          operationId: dispatched[1]?.operationId,
          status: "failed",
          error: "Selection target was hidden"
        }
      ]
    });

    expect(acked[0]?.status).toBe("succeeded");
    expect(acked[0]?.result?.createdNodeId).toBe("9:1");
    expect(acked[1]?.status).toBe("failed");
    expect(acked[1]?.error).toContain("hidden");
  });

  it("does not split a batch when pull limit is smaller than the batch size", async () => {
    const store = await createStore();
    await store.registerSession({ sessionId: "session-3b" });

    await store.enqueueOperations({
      sessionId: "session-3b",
      operations: [
        {
          type: "set_selection",
          selectionIds: ["1:1"]
        },
        {
          type: "set_selection",
          selectionIds: ["1:2"]
        }
      ]
    });

    const dispatched = await store.pullQueuedOperations("session-3b", 1);
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]?.batchId).toBe(dispatched[1]?.batchId);
  });

  it("writes bridge state to disk", async () => {
    const store = await createStore();
    await store.registerSession({ sessionId: "session-4", fileName: "Persisted" });

    const status = await store.getStatus("session-4");
    const statePath = (store as unknown as { statePath: string }).statePath;
    const raw = await readFile(statePath, "utf8");
    const persisted = JSON.parse(raw) as { sessions: Record<string, { fileName?: string }> };

    expect(status.sessions).toHaveLength(1);
    expect(persisted.sessions["session-4"]?.fileName).toBe("Persisted");
  });

  it("searches live components across stored snapshots", async () => {
    const store = await createStore();
    await store.registerSession({
      sessionId: "session-components",
      fileName: "Travel Kit"
    });
    await store.upsertSnapshot({
      sessionId: "session-components",
      fileName: "Travel Kit",
      components: [
        {
          id: "component-1",
          key: "component-key-1",
          name: "Button / Primary",
          pageId: "page-1",
          pageName: "Buttons"
        },
        {
          id: "component-2",
          key: "component-key-2",
          name: "Card / Destination",
          pageId: "page-2",
          pageName: "Cards"
        }
      ],
      nodes: [],
      variables: []
    });

    const results = await store.searchComponents({ query: "Button" });
    expect(results).toHaveLength(1);
    expect(results[0]?.component.key).toBe("component-key-1");
    expect(results[0]?.fileName).toBe("Travel Kit");
  });

  it("resolves the best component reference for a target session", async () => {
    const store = await createStore();
    await store.registerSession({
      sessionId: "target-session",
      fileName: "App File"
    });
    await store.registerSession({
      sessionId: "kit-session",
      fileName: "Travel Kit"
    });

    await store.upsertSnapshot({
      sessionId: "kit-session",
      fileName: "Travel Kit",
      nodes: [],
      variables: [],
      components: [
        {
          id: "remote-component",
          key: "remote-key",
          name: "Button / Primary",
          pageName: "Buttons"
        }
      ]
    });

    const resolved = await store.resolveComponentReference({
      targetSessionId: "target-session",
      sourceSessionId: "kit-session",
      query: "Button"
    });

    expect(resolved.chosen?.sessionId).toBe("kit-session");
    expect(resolved.componentId).toBeUndefined();
    expect(resolved.componentKey).toBe("remote-key");
  });
  it("acknowledges a skipped operation and persists it", async () => {
    const store = await createStore();
    await store.registerSession({ sessionId: "session-skip" });

    const queued = await store.enqueueOperations({
      sessionId: "session-skip",
      operations: [
        {
          type: "create_node",
          node: { type: "FRAME", name: "First" }
        },
        {
          type: "set_selection",
          selectionIds: ["1:1"]
        }
      ]
    });

    const dispatched = await store.pullQueuedOperations("session-skip", 10);
    expect(dispatched).toHaveLength(2);

    // Acknowledge first as failed, second as skipped (never executed)
    const acked = await store.acknowledgeOperations({
      sessionId: "session-skip",
      updates: [
        {
          operationId: dispatched[0]!.operationId,
          status: "failed",
          error: "Permission denied"
        },
        {
          operationId: dispatched[1]!.operationId,
          status: "skipped",
          error: "Batch failed before this operation was executed"
        }
      ]
    });

    expect(acked[0]?.status).toBe("failed");
    expect(acked[1]?.status).toBe("skipped");
    expect(acked[1]?.error).toContain("before this operation");

    // Verify status persists through getStatus
    const statusResult = await store.getStatus("session-skip");
    const skippedOp = statusResult.operations.find((op) => op.operationId === dispatched[1]!.operationId);
    expect(skippedOp?.status).toBe("skipped");
  });
});
