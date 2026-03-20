/**
 * E2E: materialize-asset trace ownership, tree retrieval, and failure persistence.
 *
 * Validates:
 * 1. materializeFigmaAssetTraced emits a parent trace, ensure-session + queue-execution are children.
 * 2. getTraceTree returns the full tree.
 * 3. Failed flows still persist traces to disk via finally-style persistence.
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { BridgeStore } from "../src/bridge-store.js";
import { materializeFigmaAssetTraced } from "../src/materialize-figma-asset.js";
import { LibraryIndex } from "../src/library-index.js";
import { ensureTalkToFigmaSession } from "../src/talk-to-figma-session.js";
import { executeTalkToFigmaSessionQueue } from "../src/talk-to-figma-queue.js";
import { createTraceContext, recordTrace, type TraceRecord } from "../src/trace-store.js";

// ---------------------------------------------------------------------------
// Stub helpers — deterministic mocks that avoid real Figma connections.
//
// Note: executeQueueMaybeTraced in materialize-figma-asset.ts wraps these
// mocks with inline trace emission, so the mocks themselves do NOT need
// to produce queue-execution traces. The ensure-session mock DOES emit
// its own trace because materializeFigmaAsset calls ensureSession directly.
// ---------------------------------------------------------------------------

function createEnsureSession() {
  return async (input: Parameters<typeof ensureTalkToFigmaSession>[0]) => {
    // Emit ensure-session trace (materializeFigmaAsset calls ensure directly,
    // so the mock must produce the trace just like the real function does).
    const traceCtx = createTraceContext(input.traceStore, input.parentTraceId);
    const startedAt = new Date().toISOString();

    const result = {
      strategy: "existing-session" as const,
      session: {
        sessionId: input.sessionId ?? "talk-to-figma:trace-e2e",
        metadata: {
          source: "talk-to-figma",
          channel: "trace-e2e",
          wsUrl: "ws://127.0.0.1:9999",
        },
        selectionIds: [] as string[],
      },
      snapshot: {
        sessionId: input.sessionId ?? "talk-to-figma:trace-e2e",
        selectionIds: [] as string[],
        nodes: [] as { id: string; name: string; type: string; childIds: string[] }[],
        variables: [] as { id: string }[],
        components: [] as { id: string; key: string; name: string }[],
      },
      channel: "trace-e2e",
      wsUrl: "ws://127.0.0.1:9999",
      attempts: [{ strategy: "existing-session" as const, ok: true, health: "active" as const }],
    };

    if (traceCtx) {
      recordTrace(traceCtx, {
        flowType: "ensure-session",
        startedAt,
        status: "succeeded",
        sessionId: result.session.sessionId,
        channel: result.channel,
        input: { sessionId: input.sessionId },
        output: { strategy: result.strategy },
      });
    }

    return result;
  };
}

/**
 * Mock queue executor that succeeds.
 * executeQueueMaybeTraced wraps this with trace emission, so no trace here.
 */
function createExecuteQueueSucceeded() {
  return async () => ({
    sessionId: "talk-to-figma:trace-e2e",
    channel: "trace-e2e",
    sessionHealth: "active" as const,
    pulledCount: 1,
    processedCount: 1,
    updates: [] as { operationId: string; status: "succeeded"; error?: string; result?: Record<string, unknown>; touchedNodeIds: string[] }[],
    batches: [{ batchId: "b1", operationIds: ["op-1"], status: "succeeded" as const }],
    acknowledged: [{
      operationId: "op-1",
      sessionId: "talk-to-figma:trace-e2e",
      status: "succeeded" as const,
      operation: { type: "create_instance" as const, componentId: "btn-1" },
      createdAt: new Date().toISOString(),
      touchedNodeIds: ["inserted-node"],
    }],
    snapshotSynced: true,
  });
}

/**
 * Mock queue executor that throws.
 * executeQueueMaybeTraced wraps this and will emit a failed queue-execution trace.
 */
function createExecuteQueueFailing() {
  return async () => {
    throw new Error("Simulated queue failure");
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("materialize-asset trace tree E2E", () => {
  const dirs: string[] = [];
  afterEach(async () => { dirs.splice(0); });

  it("materializeFigmaAssetTraced builds a trace tree with ensure-session + queue-execution children", async () => {
    const dir = await mkdtemp(join(tmpdir(), "figma-trace-tree-"));
    dirs.push(dir);
    const store = new BridgeStore(join(dir, "bridge-state.json"));
    await store.init();

    const libraryIndex = new LibraryIndex();
    libraryIndex.addFromLiveSession("talk-to-figma:trace-e2e", [
      { id: "btn-1", key: "published-key-1", name: "Button" },
    ]);

    const traceStore = await store.getTraceStore();

    const result = await materializeFigmaAssetTraced({
      store,
      query: "Button",
      sessionId: "talk-to-figma:trace-e2e",
      libraryIndex,
      traceStore,
      ensureSession: createEnsureSession() as unknown as typeof ensureTalkToFigmaSession,
      executeQueue: createExecuteQueueSucceeded() as unknown as typeof executeTalkToFigmaSessionQueue,
    });
    await store.persistTraces();

    // ── Verify the result is correct ──────────────────────────────────────
    expect(result.ensured.session.sessionId).toBe("talk-to-figma:trace-e2e");
    expect(result.importReport.attempts.length).toBeGreaterThanOrEqual(1);
    expect(result.importReport.attempts[0]?.success).toBe(true);

    // ── Verify trace tree structure ───────────────────────────────────────
    const allTraces = traceStore.getRecentTraces(50);
    const materializeTrace = allTraces.find((t) => t.flowType === "materialize-asset");
    expect(materializeTrace).toBeDefined();
    expect(materializeTrace!.status).toBe("succeeded");

    // Get the full tree
    const tree = traceStore.getTraceTree(materializeTrace!.traceId);
    expect(tree.length).toBeGreaterThanOrEqual(3); // materialize + ensure-session + queue-execution

    const flowTypes = tree.map((t) => t.flowType).sort();
    expect(flowTypes).toContain("materialize-asset");
    expect(flowTypes).toContain("ensure-session");
    expect(flowTypes).toContain("queue-execution");

    // All children should have parentTraceId === materialize traceId
    const children = tree.filter((t) => t.traceId !== materializeTrace!.traceId);
    for (const child of children) {
      expect(child.parentTraceId).toBe(materializeTrace!.traceId);
    }

    // ── Verify persistence to disk ────────────────────────────────────────
    const tracesPath = join(dir, "traces.json");
    const rawTraces = await readFile(tracesPath, "utf8");
    const diskTraces = JSON.parse(rawTraces) as TraceRecord[];
    expect(diskTraces.length).toBeGreaterThanOrEqual(3);
    expect(diskTraces.some((t) => t.traceId === materializeTrace!.traceId)).toBe(true);
  });

  it("failure scenario still persists traces to disk via finally", async () => {
    const dir = await mkdtemp(join(tmpdir(), "figma-trace-fail-"));
    dirs.push(dir);
    const store = new BridgeStore(join(dir, "bridge-state.json"));
    await store.init();

    const libraryIndex = new LibraryIndex();
    libraryIndex.addFromLiveSession("talk-to-figma:trace-e2e", [
      { id: "btn-1", key: "published-key-1", name: "Button" },
    ]);

    const traceStore = await store.getTraceStore();

    // The queue executor will throw — materializeFigmaAssetTraced should
    // still record its own failed trace record.
    let caughtError: Error | null = null;
    try {
      await materializeFigmaAssetTraced({
        store,
        query: "Button",
        sessionId: "talk-to-figma:trace-e2e",
        libraryIndex,
        traceStore,
        ensureSession: createEnsureSession() as unknown as typeof ensureTalkToFigmaSession,
        executeQueue: createExecuteQueueFailing() as unknown as typeof executeTalkToFigmaSessionQueue,
        insertAsset: async () => { throw new Error("Desktop panel also fails"); },
      });
    } catch (error) {
      caughtError = error as Error;
    }
    // Persist like the finally block in bridge-http/server would
    await store.persistTraces();

    expect(caughtError).toBeDefined();
    // The last strategy (desktop-panel) also fails, so its error propagates.
    expect(caughtError!.message).toContain("Desktop panel also fails");

    // ── Verify traces were still recorded despite failure ─────────────────
    const allTraces = traceStore.getRecentTraces(50);
    expect(allTraces.length).toBeGreaterThanOrEqual(1);

    // The ensure-session child trace should be "succeeded"
    const ensureTrace = allTraces.find((t) => t.flowType === "ensure-session");
    expect(ensureTrace).toBeDefined();
    expect(ensureTrace!.status).toBe("succeeded");

    // The queue-execution child trace should be "failed" (wrapped by executeQueueMaybeTraced)
    const queueTrace = allTraces.find((t) => t.flowType === "queue-execution");
    expect(queueTrace).toBeDefined();
    expect(queueTrace!.status).toBe("failed");
    expect(queueTrace!.errors.length).toBeGreaterThan(0);

    // ── Verify failure traces persisted to disk ───────────────────────────
    const tracesPath = join(dir, "traces.json");
    const rawTraces = await readFile(tracesPath, "utf8");
    const diskTraces = JSON.parse(rawTraces) as TraceRecord[];
    expect(diskTraces.length).toBeGreaterThanOrEqual(2); // at least ensure-session + queue-execution
    expect(diskTraces.some((t) => t.flowType === "queue-execution" && t.status === "failed")).toBe(true);
  });
});
