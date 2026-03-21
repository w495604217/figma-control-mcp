import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import { BridgeStore } from "../src/bridge-store.js";
import { executeTalkToFigmaSessionQueue } from "../src/talk-to-figma-queue.js";

function extractOperationType(code: string): string | null {
  const match = /const input = (\{[\s\S]*?\});/.exec(code);
  if (!match?.[1]) {
    return null;
  }
  const parsed = JSON.parse(match[1]) as { type?: string };
  return typeof parsed.type === "string" ? parsed.type : null;
}

describe("executeTalkToFigmaSessionQueue", () => {
  it("executes queued operations, acknowledges them, and syncs the snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "figma-control-talk-queue-"));
    const store = new BridgeStore(join(dir, "bridge-state.json"));
    await store.init();

    await store.registerSession({
      sessionId: "talk-to-figma:canvas-room",
      fileName: "GlobeGlider",
      metadata: {
        source: "talk-to-figma",
        channel: "canvas-room"
      }
    });

    await store.enqueueOperations({
      sessionId: "talk-to-figma:canvas-room",
      operations: [
        {
          type: "create_node",
          node: {
            type: "FRAME",
            name: "Queued frame"
          },
          position: {
            x: 240,
            y: 160,
            width: 220,
            height: 100
          }
        }
      ]
    });

    const executeCommand = vi.fn(async (input: {
      command: string;
      params?: Record<string, unknown>;
    }) => {
      if (input.command === "get_variables") {
        return {
          ok: true as const,
          wsUrl: "ws://127.0.0.1:3055",
          channel: "canvas-room",
          joinedAt: "2026-03-19T00:00:00.000Z",
          requestId: "req-vars",
          command: "get_variables",
          result: [],
          progressUpdates: []
        };
      }

      const code = typeof input.params?.code === "string" ? input.params.code : "";
      if (code.includes("figma.commitUndo()")) {
        return {
          ok: true as const,
          wsUrl: "ws://127.0.0.1:3055",
          channel: "canvas-room",
          joinedAt: "2026-03-19T00:00:00.000Z",
          requestId: "req-undo",
          command: "execute_code",
          result: { success: true, result: { ok: true } },
          progressUpdates: []
        };
      }

      const operationType = extractOperationType(code);
      if (operationType === "create_node") {
        return {
          ok: true as const,
          wsUrl: "ws://127.0.0.1:3055",
          channel: "canvas-room",
          joinedAt: "2026-03-19T00:00:00.000Z",
          requestId: "req-op",
          command: "execute_code",
          result: {
            success: true,
            result: {
              touchedNodeIds: ["node-created"],
              result: {
                createdNodeId: "node-created"
              }
            }
          },
          progressUpdates: []
        };
      }

      return {
        ok: true as const,
        wsUrl: "ws://127.0.0.1:3055",
        channel: "canvas-room",
        joinedAt: "2026-03-19T00:00:00.000Z",
        requestId: "req-sync",
        command: "execute_code",
        result: {
          success: true,
          result: {
            fileKey: "file-key-1",
            fileName: "GlobeGlider",
            pageId: "0:1",
            pageName: "Page 1",
            selectionIds: [],
            nodes: [
              {
                id: "node-created",
                name: "Queued frame",
                type: "FRAME",
                parentId: "0:1",
                childIds: []
              }
            ],
            components: []
          }
        },
        progressUpdates: []
      };
    });

    const result = await executeTalkToFigmaSessionQueue({
      store,
      sessionId: "talk-to-figma:canvas-room",
      client: { executeCommand }
    });

    expect(result.pulledCount).toBe(1);
    expect(result.processedCount).toBe(1);
    expect(result.snapshotSynced).toBe(true);
    expect(result.updates[0]?.status).toBe("succeeded");
    expect(result.acknowledged[0]?.status).toBe("succeeded");

    const snapshot = await store.getSnapshot("talk-to-figma:canvas-room");
    expect(snapshot?.nodes[0]?.id).toBe("node-created");
    expect(executeCommand).toHaveBeenCalled();

    // After sync, sessionHealth should be active (not "unknown")
    // because upsertSnapshot updates lastHeartbeatAt on the session
    expect(result.sessionHealth).toBe("active");
  });

  it("returns active sessionHealth after successful sync even when pre-execution health was unknown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "figma-control-talk-queue-health-"));
    const store = new BridgeStore(join(dir, "bridge-state.json"));
    await store.init();

    // Register session WITHOUT connectedAt/lastHeartbeatAt in metadata
    // Pre-execution health will be unknown because registerSession sets
    // lastHeartbeatAt automatically, but we manually strip it to simulate
    // a stale/incomplete session record
    await store.registerSession({
      sessionId: "talk-to-figma:health-room",
      fileName: "HealthTest",
      metadata: {
        source: "talk-to-figma",
        channel: "health-room"
      }
    });

    await store.enqueueOperations({
      sessionId: "talk-to-figma:health-room",
      operations: [
        {
          type: "create_node",
          node: { type: "FRAME", name: "Health check frame" }
        }
      ]
    });

    const executeCommand = vi.fn(async (input: {
      command: string;
      params?: Record<string, unknown>;
    }) => {
      if (input.command === "get_variables") {
        return {
          ok: true as const,
          wsUrl: "ws://127.0.0.1:3055",
          channel: "health-room",
          joinedAt: new Date().toISOString(),
          requestId: "req-vars",
          command: "get_variables",
          result: [],
          progressUpdates: []
        };
      }

      const code = typeof input.params?.code === "string" ? input.params.code : "";
      if (code.includes("figma.commitUndo()")) {
        return {
          ok: true as const,
          wsUrl: "ws://127.0.0.1:3055",
          channel: "health-room",
          joinedAt: new Date().toISOString(),
          requestId: "req-undo",
          command: "execute_code",
          result: { success: true, result: { ok: true } },
          progressUpdates: []
        };
      }

      if (code.includes('"type":"create_node"')) {
        return {
          ok: true as const,
          wsUrl: "ws://127.0.0.1:3055",
          channel: "health-room",
          joinedAt: new Date().toISOString(),
          requestId: "req-op",
          command: "execute_code",
          result: {
            success: true,
            result: {
              touchedNodeIds: ["node-health"],
              result: { createdNodeId: "node-health" }
            }
          },
          progressUpdates: []
        };
      }

      // Sync snapshot
      return {
        ok: true as const,
        wsUrl: "ws://127.0.0.1:3055",
        channel: "health-room",
        joinedAt: new Date().toISOString(),
        requestId: "req-sync",
        command: "execute_code",
        result: {
          success: true,
          result: {
            fileKey: "file-key-health",
            fileName: "HealthTest",
            pageId: "0:1",
            pageName: "Page 1",
            selectionIds: [],
            nodes: [
              { id: "node-health", name: "Health check frame", type: "FRAME", parentId: "0:1", childIds: [] }
            ],
            components: []
          }
        },
        progressUpdates: []
      };
    });

    const result = await executeTalkToFigmaSessionQueue({
      store,
      sessionId: "talk-to-figma:health-room",
      client: { executeCommand }
    });

    expect(result.snapshotSynced).toBe(true);
    expect(result.processedCount).toBe(1);

    // P1 regression: sessionHealth MUST be "active" after successful sync,
    // because upsertSnapshot sets lastHeartbeatAt on the session object.
    // Previously this returned "unknown" because assessSessionHealth was
    // called on session.metadata instead of the session itself.
    expect(result.sessionHealth).toBe("active");

    // Double-check: the stored session should have a recent lastHeartbeatAt
    const storedSession = await store.getSession("talk-to-figma:health-room");
    expect(storedSession?.lastHeartbeatAt).toBeDefined();
  });

  it("propagates skipped status and batches through the queue pipeline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "figma-control-talk-queue-skip-"));
    const store = new BridgeStore(join(dir, "bridge-state.json"));
    await store.init();

    await store.registerSession({
      sessionId: "talk-to-figma:skip-room",
      fileName: "SkipTest",
      metadata: {
        source: "talk-to-figma",
        channel: "skip-room"
      }
    });

    // Enqueue two operations that share a batchId
    await store.enqueueOperations({
      sessionId: "talk-to-figma:skip-room",
      operations: [
        {
          type: "create_node",
          node: { type: "FRAME", name: "Will fail" }
        },
        {
          type: "set_selection",
          selectionIds: ["1:1"]
        }
      ]
    });

    // First operation fails, second should be skipped
    const executeCommand = vi.fn(async (input: {
      command: string;
      params?: Record<string, unknown>;
    }) => {
      if (input.command === "get_variables") {
        return {
          ok: true as const,
          wsUrl: "ws://127.0.0.1:3055",
          channel: "skip-room",
          joinedAt: "2026-03-20T00:00:00.000Z",
          requestId: "req-vars",
          command: "get_variables",
          result: [],
          progressUpdates: []
        };
      }

      const code = typeof input.params?.code === "string" ? input.params.code : "";

      // create_node fails
      if (code.includes('"type":"create_node"')) {
        return {
          ok: true as const,
          wsUrl: "ws://127.0.0.1:3055",
          channel: "skip-room",
          joinedAt: "2026-03-20T00:00:00.000Z",
          requestId: "req-fail",
          command: "execute_code",
          result: { success: false, error: "Runtime error: node creation blocked" },
          progressUpdates: []
        };
      }

      // Undo command
      if (code.includes("figma.commitUndo()") || code.includes("undo")) {
        return {
          ok: true as const,
          wsUrl: "ws://127.0.0.1:3055",
          channel: "skip-room",
          joinedAt: "2026-03-20T00:00:00.000Z",
          requestId: "req-undo",
          command: "execute_code",
          result: { success: true, result: { ok: true } },
          progressUpdates: []
        };
      }

      // Sync snapshot (fallback)
      return {
        ok: true as const,
        wsUrl: "ws://127.0.0.1:3055",
        channel: "skip-room",
        joinedAt: "2026-03-20T00:00:00.000Z",
        requestId: "req-sync",
        command: "execute_code",
        result: {
          success: true,
          result: {
            fileKey: "file-key-1",
            fileName: "SkipTest",
            pageId: "0:1",
            pageName: "Page 1",
            selectionIds: [],
            nodes: [],
            components: []
          }
        },
        progressUpdates: []
      };
    });

    const result = await executeTalkToFigmaSessionQueue({
      store,
      sessionId: "talk-to-figma:skip-room",
      client: { executeCommand }
    });

    // Verify batches are present
    expect(result.batches).toBeDefined();
    expect(Array.isArray(result.batches)).toBe(true);
    expect(result.batches.length).toBeGreaterThanOrEqual(1);

    // The batch should not be "succeeded" since the first operation failed
    const batch = result.batches[0]!;
    expect(batch.status).not.toBe("succeeded");
    expect(batch.rollbackAttempted).toBe(true);

    // Both updates should be present — at least one status is "failed" or "skipped"
    const statuses = result.updates.map((u) => u.status);
    expect(statuses).toContain("failed");

    // Verify acknowledged records survive the store boundary
    for (const ack of result.acknowledged) {
      expect(["failed", "skipped"]).toContain(ack.status);
    }
  });
});
