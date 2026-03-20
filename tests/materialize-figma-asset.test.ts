import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { BridgeStore } from "../src/bridge-store.js";
import { materializeFigmaAsset } from "../src/materialize-figma-asset.js";
import { LibraryIndex } from "../src/library-index.js";

async function createStore() {
  const dir = await mkdtemp(join(tmpdir(), "figma-control-materialize-"));
  const store = new BridgeStore(join(dir, "bridge-state.json"));
  await store.init();
  return store;
}

function createEnsureSession() {
  return async () => ({
    strategy: "existing-session" as const,
    session: {
      sessionId: "talk-to-figma:canvas-room",
      metadata: {
        source: "talk-to-figma",
        channel: "canvas-room",
        wsUrl: "ws://127.0.0.1:3055",
      },
      selectionIds: [],
    },
    snapshot: {
      sessionId: "talk-to-figma:canvas-room",
      selectionIds: [],
      nodes: [],
      variables: [],
      components: [],
    },
    channel: "canvas-room",
    wsUrl: "ws://127.0.0.1:3055",
    attempts: [],
  });
}

function createDesktopInsert(query: string) {
  return async () => ({
    query,
    resultIndex: 0,
    dryRun: false,
    inserted: true,
    window: { x: 0, y: 0, w: 100, h: 100 },
    match: {
      text: query,
      normalizedText: query,
      canonicalText: query.toLowerCase(),
    },
    from: { x: 10, y: 10 },
    to: { x: 50, y: 50 },
    sync: {
      session: {
        sessionId: "talk-to-figma:canvas-room",
        selectionIds: [],
        metadata: { source: "talk-to-figma", channel: "canvas-room" },
      },
      snapshot: {
        sessionId: "talk-to-figma:canvas-room",
        selectionIds: [],
        nodes: [],
        variables: [],
        components: [],
      },
      delta: {
        addedNodes: [
          { id: "toolbar-node", name: query, type: "FRAME", childIds: [], pluginData: {} },
        ],
        removedNodeIds: [],
        addedSelectionIds: [],
        removedSelectionIds: [],
      },
      insertedNodes: [
        { id: "toolbar-node", name: query, type: "FRAME", childIds: [], pluginData: {} },
      ],
      channel: "canvas-room",
    },
  });
}

/**
 * Create a queue executor mock that returns an acknowledgement with
 * the given status.  When `status` is "succeeded" the run also reports
 * touchedNodeIds.
 */
function createExecuteQueueWithStatus(status: "succeeded" | "failed") {
  return async () => ({
    sessionId: "talk-to-figma:canvas-room",
    channel: "canvas-room",
    pulledCount: 1,
    processedCount: 1,
    updates: [] as { operationId: string; status: "succeeded" | "failed" | "dispatched"; error?: string; result?: Record<string, unknown>; touchedNodeIds: string[] }[],
    acknowledged: [
      {
        operationId: "op-1",
        sessionId: "talk-to-figma:canvas-room",
        status,
        operation: { type: "create_instance" as const, componentId: "btn-1" },
        createdAt: new Date().toISOString(),
        touchedNodeIds: status === "succeeded" ? ["inserted-btn"] : [] as string[],
      },
    ],
    snapshotSynced: true,
  });
}

/** Legacy helper — returns a run with NO acknowledgements (only processedCount). */
function createExecuteQueueNoAck() {
  return async () => ({
    sessionId: "talk-to-figma:canvas-room",
    channel: "canvas-room",
    pulledCount: 1,
    processedCount: 1,
    updates: [] as { operationId: string; status: "succeeded" | "failed" | "dispatched"; error?: string; result?: Record<string, unknown>; touchedNodeIds: string[] }[],
    acknowledged: [] as { operationId: string; status: "succeeded" | "failed" | "dispatched" | "queued"; error?: string; result?: Record<string, unknown>; touchedNodeIds: string[] }[],
    snapshotSynced: true,
  });
}

describe("materializeFigmaAsset", () => {
  it("selects inserted nodes after a synced insert and includes importReport", async () => {
    const store = await createStore();

    const result = await materializeFigmaAsset({
      store,
      query: "Toolbar",
      sessionId: "talk-to-figma:canvas-room",
      ensureSession: createEnsureSession(),
      insertAsset: createDesktopInsert("Toolbar"),
      executeQueue: createExecuteQueueNoAck(),
    });

    const status = await store.getStatus("talk-to-figma:canvas-room");

    expect(result.ensured.session.sessionId).toBe("talk-to-figma:canvas-room");
    expect(result.selectedNodeIds).toEqual(["toolbar-node"]);
    expect(result.selectionRun?.processedCount).toBe(1);
    expect(status.operations).toHaveLength(1);
    expect(status.operations[0]?.operation.type).toBe("set_selection");

    // ImportReport should show desktop-panel as the strategy used
    expect(result.importReport).toBeDefined();
    expect(result.importReport.strategyUsed).toBe("desktop-panel");
    expect(result.importReport.indexHit).toBe(false);
    expect(result.importReport.attempts).toHaveLength(1);
    expect(result.importReport.attempts[0]?.strategy).toBe("desktop-panel");
    expect(result.importReport.attempts[0]?.success).toBe(true);
  });

  it("attempts runtime strategy first when library index has a matching componentKey", async () => {
    const store = await createStore();

    const libraryIndex = new LibraryIndex();
    libraryIndex.addFromLiveSession("talk-to-figma:canvas-room", [
      { id: "btn-1", key: "published-key-123", name: "Button" },
    ]);

    let runtimeAttempted = false;
    let desktopAttempted = false;

    const result = await materializeFigmaAsset({
      store,
      query: "Button",
      sessionId: "talk-to-figma:canvas-room",
      libraryIndex,
      ensureSession: createEnsureSession(),
      insertAsset: async () => {
        desktopAttempted = true;
        return (createDesktopInsert("Button"))();
      },
      executeQueue: async () => {
        runtimeAttempted = true;
        return {
          sessionId: "talk-to-figma:canvas-room",
          channel: "canvas-room",
          pulledCount: 1,
          processedCount: 1,
          updates: [],
          acknowledged: [
            {
              operationId: "op-1",
              sessionId: "talk-to-figma:canvas-room",
              status: "succeeded" as const,
              operation: { type: "create_instance" as const, componentId: "btn-1" },
              createdAt: new Date().toISOString(),
              touchedNodeIds: ["inserted-btn"],
            },
          ],
          snapshotSynced: true,
        };
      },
    });

    expect(runtimeAttempted).toBe(true);
    expect(desktopAttempted).toBe(false);

    expect(result.importReport.strategyUsed).toBe("runtime");
    expect(result.importReport.indexHit).toBe(true);
    expect(result.importReport.componentKey).toBe("published-key-123");
    expect(result.importReport.componentId).toBe("btn-1");
    expect(result.importReport.attempts).toHaveLength(1);
    expect(result.importReport.attempts[0]?.strategy).toBe("runtime");
    expect(result.importReport.attempts[0]?.success).toBe(true);
  });

  it("falls back to desktop-panel when runtime strategy fails", async () => {
    const store = await createStore();

    const libraryIndex = new LibraryIndex();
    libraryIndex.addFromLiveSession("other-session", [
      { id: "btn-1", key: "published-key-456", name: "Button" },
    ]);

    let executeQueueCallCount = 0;

    const result = await materializeFigmaAsset({
      store,
      query: "Button",
      sessionId: "talk-to-figma:canvas-room",
      libraryIndex,
      ensureSession: createEnsureSession(),
      insertAsset: createDesktopInsert("Button"),
      executeQueue: async () => {
        executeQueueCallCount += 1;
        if (executeQueueCallCount === 1) {
          throw new Error("importComponentByKeyAsync failed");
        }
        return createExecuteQueueNoAck()();
      },
    });

    expect(result.importReport.strategyUsed).toBe("desktop-panel");
    expect(result.importReport.indexHit).toBe(true);
    expect(result.importReport.attempts).toHaveLength(2);
    expect(result.importReport.attempts[0]?.strategy).toBe("published-key");
    expect(result.importReport.attempts[0]?.success).toBe(false);
    expect(result.importReport.attempts[0]?.error).toContain("importComponentByKeyAsync");
    expect(result.importReport.attempts[1]?.strategy).toBe("desktop-panel");
    expect(result.importReport.attempts[1]?.success).toBe(true);
  });

  it("uses desktop-panel directly when library index has no match", async () => {
    const store = await createStore();
    const libraryIndex = new LibraryIndex();

    const result = await materializeFigmaAsset({
      store,
      query: "Nonexistent",
      sessionId: "talk-to-figma:canvas-room",
      libraryIndex,
      ensureSession: createEnsureSession(),
      insertAsset: createDesktopInsert("Nonexistent"),
      executeQueue: createExecuteQueueNoAck(),
    });

    expect(result.importReport.strategyUsed).toBe("desktop-panel");
    expect(result.importReport.indexHit).toBe(false);
    expect(result.importReport.attempts).toHaveLength(1);
  });

  // ── Audit blocker test: deterministic import with all-failed acks ──────
  it("treats processedCount > 0 with all-failed acknowledgements as failure and falls back to desktop", async () => {
    const store = await createStore();

    const libraryIndex = new LibraryIndex();
    libraryIndex.addFromLiveSession("talk-to-figma:canvas-room", [
      { id: "btn-1", key: "pk-btn", name: "Button" },
    ]);

    let executeQueueCallCount = 0;
    let desktopInsertCalled = false;

    const result = await materializeFigmaAsset({
      store,
      query: "Button",
      sessionId: "talk-to-figma:canvas-room",
      libraryIndex,
      ensureSession: createEnsureSession(),
      insertAsset: async () => {
        desktopInsertCalled = true;
        return (createDesktopInsert("Button"))();
      },
      executeQueue: async () => {
        executeQueueCallCount += 1;
        if (executeQueueCallCount <= 2) {
          // First two calls: runtime and published-key both return
          // processedCount > 0 but with failed acknowledgements.
          return {
            sessionId: "talk-to-figma:canvas-room",
            channel: "canvas-room",
            pulledCount: 1,
            processedCount: 1,
            updates: [] as { operationId: string; status: "succeeded" | "failed" | "dispatched"; error?: string; result?: Record<string, unknown>; touchedNodeIds: string[] }[],
            acknowledged: [
              {
                operationId: `op-${executeQueueCallCount}`,
                sessionId: "talk-to-figma:canvas-room",
                status: "failed" as const,
                operation: { type: "create_instance" as const, componentId: "btn-1" },
                createdAt: new Date().toISOString(),
                error: "Import failed on runtime side",
                touchedNodeIds: [] as string[],
              },
            ],
            snapshotSynced: true,
          };
        }
        // Subsequent call: selection after desktop insert
        return createExecuteQueueNoAck()();
      },
    });

    // Runtime + published-key both failed, desktop should have been used
    expect(desktopInsertCalled).toBe(true);
    expect(result.importReport.strategyUsed).toBe("desktop-panel");
    expect(result.importReport.attempts.length).toBeGreaterThanOrEqual(3);

    // Verify runtime was marked as failed even though processedCount was 1
    const runtimeAttempt = result.importReport.attempts.find(a => a.strategy === "runtime");
    expect(runtimeAttempt).toBeDefined();
    expect(runtimeAttempt?.success).toBe(false);

    // Verify published-key was also marked as failed
    const pkAttempt = result.importReport.attempts.find(a => a.strategy === "published-key");
    expect(pkAttempt).toBeDefined();
    expect(pkAttempt?.success).toBe(false);

    // Desktop succeeded
    const desktopAttempt = result.importReport.attempts.find(a => a.strategy === "desktop-panel");
    expect(desktopAttempt).toBeDefined();
    expect(desktopAttempt?.success).toBe(true);
  });

  // ── Audit blocker test: dryRun with deterministic index hit ────────────
  it("does not enqueue or execute mutations when dryRun is true and library index has a hit", async () => {
    const store = await createStore();

    const libraryIndex = new LibraryIndex();
    libraryIndex.addFromLiveSession("talk-to-figma:canvas-room", [
      { id: "btn-1", key: "pk-btn", name: "Button" },
    ]);

    let executeQueueCalled = false;
    let insertAssetCalled = false;

    const result = await materializeFigmaAsset({
      store,
      query: "Button",
      sessionId: "talk-to-figma:canvas-room",
      dryRun: true,
      libraryIndex,
      ensureSession: createEnsureSession(),
      insertAsset: async () => {
        insertAssetCalled = true;
        return (createDesktopInsert("Button"))();
      },
      executeQueue: async () => {
        executeQueueCalled = true;
        return createExecuteQueueWithStatus("succeeded")();
      },
    });

    // No mutating operations should have been called
    expect(executeQueueCalled).toBe(false);
    expect(insertAssetCalled).toBe(false);

    // No operations should have been enqueued
    const status = await store.getStatus("talk-to-figma:canvas-room");
    expect(status.operations).toHaveLength(0);

    // Result should be dry-run-safe
    expect(result.inserted.dryRun).toBe(true);
    expect(result.inserted.inserted).toBe(false);
    expect(result.selectedNodeIds).toEqual([]);

    // ImportReport should record the strategy as a success (dry-run)
    expect(result.importReport.indexHit).toBe(true);
    expect(result.importReport.strategyUsed).toBe("runtime");
    expect(result.importReport.attempts).toHaveLength(1);
    expect(result.importReport.attempts[0]?.success).toBe(true);
  });

  // ── Audit blocker test: component_set excluded from published-key ──────
  it("skips published-key for component_set entries and falls back to desktop", async () => {
    const store = await createStore();

    const libraryIndex = new LibraryIndex();
    libraryIndex.addFromRest([{
      source: "rest",
      kind: "component_set",
      key: "pk-set-1",
      fileKey: "fk-1",
      nodeId: "2:1",
      name: "Button",
    }]);

    let executeQueueCalled = false;

    const result = await materializeFigmaAsset({
      store,
      query: "Button",
      sessionId: "talk-to-figma:canvas-room",
      libraryIndex,
      ensureSession: createEnsureSession(),
      insertAsset: createDesktopInsert("Button"),
      executeQueue: async () => {
        executeQueueCalled = true;
        return createExecuteQueueNoAck()();
      },
    });

    // published-key should NOT have been attempted (component_set)
    const pkAttempt = result.importReport.attempts.find(a => a.strategy === "published-key");
    expect(pkAttempt).toBeUndefined();

    // Runtime should NOT have been attempted (different session, component_set)
    const rtAttempt = result.importReport.attempts.find(a => a.strategy === "runtime");
    expect(rtAttempt).toBeUndefined();

    // Desktop should have been used
    expect(result.importReport.strategyUsed).toBe("desktop-panel");
    expect(result.importReport.indexHit).toBe(true);
    expect(result.importReport.attempts).toHaveLength(1);
    expect(result.importReport.attempts[0]?.strategy).toBe("desktop-panel");
    expect(result.importReport.attempts[0]?.success).toBe(true);
  });
});
