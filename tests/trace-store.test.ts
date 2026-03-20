import { describe, it, expect, beforeEach } from "vitest";
import { TraceStore, recordTrace, createTraceContext, type TraceRecord, type TraceContext } from "../src/trace-store.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrace(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    traceId: overrides.traceId ?? `trace-${Math.random().toString(36).slice(2, 8)}`,
    flowType: overrides.flowType ?? "ensure-session",
    startedAt: overrides.startedAt ?? new Date().toISOString(),
    completedAt: overrides.completedAt ?? new Date().toISOString(),
    durationMs: overrides.durationMs ?? 42,
    status: overrides.status ?? "succeeded",
    input: overrides.input ?? {},
    output: overrides.output ?? {},
    warnings: overrides.warnings ?? [],
    errors: overrides.errors ?? [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TraceStore unit tests
// ---------------------------------------------------------------------------

describe("TraceStore", () => {
  let store: TraceStore;

  beforeEach(() => {
    store = new TraceStore();
  });

  it("adds a trace and retrieves it via getRecentTraces", () => {
    const trace = makeTrace({ traceId: "t1" });
    store.addTrace(trace);
    const recent = store.getRecentTraces();
    expect(recent).toHaveLength(1);
    expect(recent[0]!.traceId).toBe("t1");
  });

  it("enforces retention limit (ring buffer eviction)", () => {
    const small = new TraceStore(3);
    small.addTrace(makeTrace({ traceId: "t1" }));
    small.addTrace(makeTrace({ traceId: "t2" }));
    small.addTrace(makeTrace({ traceId: "t3" }));
    small.addTrace(makeTrace({ traceId: "t4" }));
    expect(small.size).toBe(3);
    expect(small.getTrace("t1")).toBeNull();
    expect(small.getTrace("t2")).not.toBeNull();
    expect(small.getTrace("t4")).not.toBeNull();
  });

  it("gets a trace by ID", () => {
    const trace = makeTrace({ traceId: "lookup-me" });
    store.addTrace(trace);
    store.addTrace(makeTrace({ traceId: "other" }));
    const found = store.getTrace("lookup-me");
    expect(found).not.toBeNull();
    expect(found!.traceId).toBe("lookup-me");
  });

  it("returns null for unknown trace ID", () => {
    expect(store.getTrace("nonexistent")).toBeNull();
  });

  it("filters traces by flow type", () => {
    store.addTrace(makeTrace({ traceId: "s1", flowType: "ensure-session" }));
    store.addTrace(makeTrace({ traceId: "q1", flowType: "queue-execution" }));
    store.addTrace(makeTrace({ traceId: "s2", flowType: "ensure-session" }));
    store.addTrace(makeTrace({ traceId: "m1", flowType: "materialize-asset" }));

    const sessionTraces = store.getTracesByFlow("ensure-session");
    expect(sessionTraces).toHaveLength(2);
    expect(sessionTraces.every((t) => t.flowType === "ensure-session")).toBe(true);
  });

  it("gets trace tree (parent → children linkage)", () => {
    const parent = makeTrace({ traceId: "parent" });
    const child1 = makeTrace({ traceId: "child1", parentTraceId: "parent" });
    const child2 = makeTrace({ traceId: "child2", parentTraceId: "parent" });
    const grandchild = makeTrace({ traceId: "grandchild", parentTraceId: "child1" });
    const unrelated = makeTrace({ traceId: "unrelated" });

    store.addTrace(parent);
    store.addTrace(child1);
    store.addTrace(child2);
    store.addTrace(grandchild);
    store.addTrace(unrelated);

    const tree = store.getTraceTree("parent");
    expect(tree).toHaveLength(4);
    const treeIds = tree.map((t) => t.traceId);
    expect(treeIds).toContain("parent");
    expect(treeIds).toContain("child1");
    expect(treeIds).toContain("child2");
    expect(treeIds).toContain("grandchild");
    expect(treeIds).not.toContain("unrelated");
  });

  it("returns empty array for unknown trace tree", () => {
    const tree = store.getTraceTree("nonexistent");
    expect(tree).toHaveLength(0);
  });

  it("returns empty for empty store", () => {
    expect(store.getRecentTraces()).toHaveLength(0);
    expect(store.getTracesByFlow("ensure-session")).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  it("returns traces newest first", () => {
    store.addTrace(makeTrace({ traceId: "old", startedAt: "2024-01-01T00:00:00Z" }));
    store.addTrace(makeTrace({ traceId: "new", startedAt: "2024-12-01T00:00:00Z" }));
    const recent = store.getRecentTraces();
    expect(recent[0]!.traceId).toBe("new");
    expect(recent[1]!.traceId).toBe("old");
  });

  it("respects limit in getRecentTraces", () => {
    for (let i = 0; i < 10; i++) {
      store.addTrace(makeTrace({ traceId: `t${i}` }));
    }
    const limited = store.getRecentTraces(3);
    expect(limited).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// JSON serialization round-trip
// ---------------------------------------------------------------------------

describe("TraceStore serialization", () => {
  it("round-trips via toJSON / fromJSON", () => {
    const store = new TraceStore(5);
    store.addTrace(makeTrace({ traceId: "rt1", flowType: "queue-execution" }));
    store.addTrace(makeTrace({ traceId: "rt2", parentTraceId: "rt1" }));

    const json = store.toJSON();
    const restored = TraceStore.fromJSON(json, 5);
    expect(restored.size).toBe(2);
    expect(restored.getTrace("rt1")).not.toBeNull();
    expect(restored.getTrace("rt2")!.parentTraceId).toBe("rt1");
  });

  it("handles invalid JSON data gracefully", () => {
    const restored = TraceStore.fromJSON("not-an-array");
    expect(restored.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// File persistence
// ---------------------------------------------------------------------------

describe("TraceStore file persistence", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "trace-test-"));
  });

  it("saves and loads traces from file", async () => {
    const store = new TraceStore();
    store.addTrace(makeTrace({ traceId: "persist1" }));
    store.addTrace(makeTrace({ traceId: "persist2", parentTraceId: "persist1" }));

    const filePath = join(tempDir, "traces.json");
    await store.saveTo(filePath);

    // Verify file exists and is valid JSON
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);

    // Load and verify
    const loaded = await TraceStore.loadFrom(filePath);
    expect(loaded.size).toBe(2);
    expect(loaded.getTrace("persist1")).not.toBeNull();
    expect(loaded.getTrace("persist2")!.parentTraceId).toBe("persist1");

    await rm(tempDir, { recursive: true });
  });

  it("returns empty store when file does not exist", async () => {
    const loaded = await TraceStore.loadFrom(join(tempDir, "nonexistent.json"));
    expect(loaded.size).toBe(0);

    await rm(tempDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// recordTrace helper
// ---------------------------------------------------------------------------

describe("recordTrace", () => {
  it("creates a trace record with computed duration", () => {
    const store = new TraceStore();
    const ctx: TraceContext = {
      traceStore: store,
      traceId: "ctx-trace-1",
      parentTraceId: "parent-id",
    };

    const startedAt = new Date(Date.now() - 100).toISOString();
    const trace = recordTrace(ctx, {
      flowType: "ensure-session",
      startedAt,
      status: "succeeded",
      sessionId: "s1",
      channel: "ch1",
      input: { strategy: "existing-session" },
      output: { sessionHealth: "active" },
      warnings: ["stale session detected"],
      errors: [],
    });

    expect(trace.traceId).toBe("ctx-trace-1");
    expect(trace.parentTraceId).toBe("parent-id");
    expect(trace.flowType).toBe("ensure-session");
    expect(trace.status).toBe("succeeded");
    expect(trace.durationMs).toBeGreaterThanOrEqual(0);
    expect(trace.warnings).toContain("stale session detected");
    expect(store.size).toBe(1);
  });

  it("records failed trace with error messages", () => {
    const store = new TraceStore();
    const ctx: TraceContext = {
      traceStore: store,
      traceId: "fail-trace",
    };

    const trace = recordTrace(ctx, {
      flowType: "queue-execution",
      startedAt: new Date().toISOString(),
      status: "failed",
      input: { sessionId: "s1" },
      output: {},
      errors: ["Connection refused"],
    });

    expect(trace.status).toBe("failed");
    expect(trace.errors).toContain("Connection refused");
  });
});

// ---------------------------------------------------------------------------
// createTraceContext helper
// ---------------------------------------------------------------------------

describe("createTraceContext", () => {
  it("returns undefined when traceStore is undefined", () => {
    const ctx = createTraceContext(undefined);
    expect(ctx).toBeUndefined();
  });

  it("creates a context with new traceId and optional parentTraceId", () => {
    const store = new TraceStore();
    const ctx = createTraceContext(store, "parent-123");
    expect(ctx).toBeDefined();
    expect(ctx!.traceStore).toBe(store);
    expect(ctx!.traceId).toBeTruthy();
    expect(ctx!.parentTraceId).toBe("parent-123");
  });

  it("generates unique traceIds", () => {
    const store = new TraceStore();
    const ctx1 = createTraceContext(store);
    const ctx2 = createTraceContext(store);
    expect(ctx1!.traceId).not.toBe(ctx2!.traceId);
  });
});

// ---------------------------------------------------------------------------
// Warnings and errors in trace output
// ---------------------------------------------------------------------------

describe("trace warnings and errors", () => {
  it("captures warnings and errors appropriately", () => {
    const store = new TraceStore();
    const ctx: TraceContext = {
      traceStore: store,
      traceId: "warn-err-trace",
    };

    const trace = recordTrace(ctx, {
      flowType: "materialize-asset",
      startedAt: new Date().toISOString(),
      status: "succeeded",
      input: { query: "Button" },
      output: { strategy: "runtime" },
      warnings: ["runtime fallback to published-key attempted"],
      errors: [],
    });

    expect(trace.warnings).toHaveLength(1);
    expect(trace.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TraceStore.newTraceId
// ---------------------------------------------------------------------------

describe("TraceStore.newTraceId", () => {
  it("generates UUID-format string", () => {
    const id = TraceStore.newTraceId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
