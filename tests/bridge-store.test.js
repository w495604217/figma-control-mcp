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
    it("writes bridge state to disk", async () => {
        const store = await createStore();
        await store.registerSession({ sessionId: "session-4", fileName: "Persisted" });
        const status = await store.getStatus("session-4");
        const statePath = store.statePath;
        const raw = await readFile(statePath, "utf8");
        const persisted = JSON.parse(raw);
        expect(status.sessions).toHaveLength(1);
        expect(persisted.sessions["session-4"]?.fileName).toBe("Persisted");
    });
});
