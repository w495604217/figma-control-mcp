import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { BridgeStore } from "../src/bridge-store.js";
import { materializeFigmaAsset } from "../src/materialize-figma-asset.js";
async function createStore() {
  const dir = await mkdtemp(join(tmpdir(), "figma-control-materialize-"));
  const store = new BridgeStore(join(dir, "bridge-state.json"));
  await store.init();
  return store;
}

describe("materializeFigmaAsset", () => {
  it("selects inserted nodes after a synced insert", async () => {
    const store = await createStore();

    const result = await materializeFigmaAsset({
      store,
      query: "Toolbar",
      sessionId: "talk-to-figma:canvas-room",
      ensureSession: async () => ({
        strategy: "existing-session",
        session: {
          sessionId: "talk-to-figma:canvas-room",
          metadata: {
            source: "talk-to-figma",
            channel: "canvas-room",
            wsUrl: "ws://127.0.0.1:3055"
          },
          selectionIds: []
        },
        snapshot: {
          sessionId: "talk-to-figma:canvas-room",
          selectionIds: [],
          nodes: [],
          variables: [],
          components: []
        },
        channel: "canvas-room",
        wsUrl: "ws://127.0.0.1:3055",
        attempts: []
      }),
      insertAsset: async () => ({
        query: "Toolbar",
        resultIndex: 0,
        dryRun: false,
        inserted: true,
        window: { x: 0, y: 0, w: 100, h: 100 },
        match: {
          text: "Toolbar",
          normalizedText: "Toolbar",
          canonicalText: "toolbar"
        },
        from: { x: 10, y: 10 },
        to: { x: 50, y: 50 },
        sync: {
          session: {
            sessionId: "talk-to-figma:canvas-room",
            selectionIds: [],
            metadata: {
              source: "talk-to-figma",
              channel: "canvas-room"
            }
          },
          snapshot: {
            sessionId: "talk-to-figma:canvas-room",
            selectionIds: [],
            nodes: [],
            variables: [],
            components: []
          },
          delta: {
            addedNodes: [
              {
                id: "toolbar-node",
                name: "Toolbar",
                type: "FRAME",
                childIds: [],
                pluginData: {}
              }
            ],
            removedNodeIds: [],
            addedSelectionIds: [],
            removedSelectionIds: []
          },
          insertedNodes: [
            {
              id: "toolbar-node",
              name: "Toolbar",
              type: "FRAME",
              childIds: [],
              pluginData: {}
            }
          ],
          channel: "canvas-room"
        }
      }),
      executeQueue: async () => ({
        sessionId: "talk-to-figma:canvas-room",
        channel: "canvas-room",
        pulledCount: 1,
        processedCount: 1,
        updates: [],
        acknowledged: [],
        snapshotSynced: true
      })
    });

    const status = await store.getStatus("talk-to-figma:canvas-room");

    expect(result.ensured.session.sessionId).toBe("talk-to-figma:canvas-room");
    expect(result.selectedNodeIds).toEqual(["toolbar-node"]);
    expect(result.selectionRun?.processedCount).toBe(1);
    expect(status.operations).toHaveLength(1);
    expect(status.operations[0]?.operation.type).toBe("set_selection");
  });
});
