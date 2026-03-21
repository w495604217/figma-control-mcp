# Trace Debugging Guide

## Purpose

This guide explains how to use the structured tracing system to debug, audit, and reason about operations in Figma Control MCP.

## What Is Traced

Three key control flows emit structured trace records:

| Flow | Trigger | What it captures |
|------|---------|-----------------|
| `ensure-session` | `ensureTalkToFigmaSession` | Channel discovery, sync, health classification, recovery attempts |
| `queue-execution` | `executeTalkToFigmaSessionQueue` | Operation processing, batch outcomes, post-sync results |
| `materialize-asset` | `materializeFigmaAssetTraced` | Full session-ensure + queue-execute + import strategy cascade |

## Trace Record Fields

Every trace record contains:

| Field | Description |
|-------|-------------|
| `traceId` | Unique UUID for this trace |
| `parentTraceId` | Links child traces to parent (e.g. materialize → ensure → queue) |
| `flowType` | One of: `ensure-session`, `queue-execution`, `materialize-asset` |
| `startedAt` / `completedAt` | ISO timestamps |
| `durationMs` | Wall-clock duration |
| `status` | `succeeded` or `failed` |
| `sessionId` / `channel` | Session context if available |
| `input` | Sanitized input snapshot for replay |
| `output` | Structured result summary |
| `warnings` | Non-fatal issues (e.g. partial batch failures) |
| `errors` | Fatal error messages |

## How to Retrieve Traces

### Via CLI / curl

```bash
# Recent traces (default limit 20)
curl -s http://127.0.0.1:3847/bridge/traces | jq

# Filter by flow type
curl -s 'http://127.0.0.1:3847/bridge/traces?flowType=ensure-session' | jq

# Single trace by ID
curl -s http://127.0.0.1:3847/bridge/traces/<traceId> | jq

# Trace tree (parent + all children)
curl -s http://127.0.0.1:3847/bridge/traces/<traceId>/tree | jq
```

### Via Typed Client

```typescript
import { PluginBridgeClient } from "./src/plugin-bridge-client.js";

const client = new PluginBridgeClient();

// List recent traces
const { traces, count } = await client.getTraces({ limit: 10 });

// Filter by flow type
const ensureTraces = await client.getTraces({ flowType: "ensure-session" });

// Get a single trace by ID
const trace = await client.getTrace(traceId);

// Get the full trace tree
const { tree } = await client.getTraceTree(rootTraceId);
```

## Understanding Trace Trees

`materializeFigmaAssetTraced` creates a hierarchical trace tree:

```
materialize-asset (root)
├── ensure-session (child)
├── queue-execution (child — runtime import)
└── queue-execution (child — selection)
```

All children share the same `parentTraceId`, which is the root's `traceId`.

Use `getTraceTree(rootId)` or `GET /bridge/traces/:traceId/tree` to retrieve the entire tree in one call.

## Debugging Common Scenarios

### Why did my import fail?

1. Call `getTraces({ flowType: "materialize-asset" })`
2. Find the trace with `status: "failed"`
3. Check `errors` — each entry is a string like `"desktop-panel: window not found"`
4. For successful traces, inspect `output.succeededStrategy` (e.g. `"runtime"` or `"desktop-panel"`) and `output.attemptSummary` (e.g. `"runtime(ok), desktop-panel(skip)"`)
5. Check `input.indexHit` to see whether the query matched a library index entry
6. If the ensure-session step succeeded but materialization still failed, use `getTraceTree(traceId)` to see child traces

### Why is my session stale?

1. Call `getTraces({ flowType: "ensure-session" })`
2. Look at `output.attempts` — each entry shows `health`, `strategy`, and `error`
3. A `stale` health means the channel's `lastHeartbeatAt` exceeded the threshold

### Why did a batch partially fail?

1. Call `getTraces({ flowType: "queue-execution" })`
2. Check `warnings` — they list partially failed batches
3. Check `output.pulledCount` vs `output.processedCount`
4. Each batch in the queue result has `status`, `succeededIds`, `failedIds`, and `skippedIds`

## Persistence

Traces are stored in memory (ring buffer, default 100) and persisted to `traces.json` alongside `bridge-state.json`.

- Traces survive server restarts — they are loaded from `traces.json` on `BridgeStore.init()`
- Both success and failure traces are persisted (via `try/finally` in all handlers)
- Old traces are evicted when the ring buffer fills

## Current Limitations

- Traces are local to the bridge process (no distributed tracing)
- No metrics or histogram aggregation
- No automatic trace correlation with external systems
- Ring buffer has a fixed capacity (default 100 traces)
