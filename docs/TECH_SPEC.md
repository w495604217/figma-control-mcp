# Technical Specification

## Overview

Figma Control MCP is a layered architecture that separates:

- agent-facing intent
- session and queue state
- Figma runtime execution
- desktop fallback

This separation is required because no single Figma surface currently provides a complete programmable control plane.

## Design Principles

1. runtime-first, desktop-second
2. structured state before action
3. deterministic operations before heuristics
4. honest boundaries over fake completeness
5. recovery and re-sync are first-class concerns

## Major Components

## 1. MCP Server

Primary files:

- `src/server.ts`
- `src/schemas.ts`

Responsibilities:

- expose the tool surface
- validate requests
- map user intent to bridge operations

## 2. Local HTTP Bridge

Primary files:

- `src/bridge-http.ts`
- `src/plugin-bridge-client.ts`
- `src/index.ts`

Responsibilities:

- provide a stable local control API
- support plugin worker communication
- expose synchronization and execution endpoints

## 3. Persistent Bridge Store

Primary file:

- `src/bridge-store.ts`

Responsibilities:

- store sessions
- store snapshots
- store queued operations
- preserve execution continuity across runs

## 4. Batch Resolution and Queueing

Primary files:

- `src/batch-resolver.ts`
- `src/operation-executor.ts`
- `src/queue-executor.ts`

Responsibilities:

- resolve path-based targets
- group operations by batch
- preserve execution ordering
- support safer batched workflows
- produce structured transaction outcomes (batch status, rollback result, per-operation three-state)

## 5. Figma Plugin Worker

Primary files:

- `plugin-example/src/code.ts`
- `plugin-example/src/figma-adapter.ts`

Responsibilities:

- register and publish snapshots
- execute node-level operations inside the Figma runtime
- acknowledge and refresh state

## 6. talk-to-figma Integration

Primary files:

- `src/talk-to-figma.ts`
- `src/talk-to-figma-log.ts`
- `src/talk-to-figma-session.ts`
- `src/talk-to-figma-sync.ts`
- `src/talk-to-figma-queue.ts`
- `src/talk-to-figma-adapter.ts`

Responsibilities:

- probe and discover channels
- execute raw silent commands
- synchronize live channels into bridge sessions
- run queued operations against websocket-backed sessions

### Session Health Model

`ensureTalkToFigmaSession` classifies session health using four states:

| State | Meaning |
|-------|---------|
| `active` | Channel responded to sync; metadata is recent |
| `stale` | Stored metadata exists but `lastHeartbeatAt` exceeds threshold (default 5 min) |
| `unreachable` | Channel could not be contacted (timeout, connection refused) |
| `unknown` | Insufficient metadata to assess health |

Recovery strategy ordering: existing-session → explicit-channel → discover → launch.
A stale session is automatically skipped (not synced) and falls through to discover/launch.
Each attempt is recorded with `health`, optional `staleSince`, and optional `snapshotAge` fields.

`staleThresholdMs` is configurable (default 300 000 ms = 5 min) and propagated through:
- MCP tool `ensure_talk_to_figma_session` (Zod-validated, max 1 h)
- HTTP route `POST /bridge/talk-to-figma/ensure-session`
- Typed client `PluginBridgeClient.ensureTalkToFigmaSession`

### Queue sessionHealth Semantics

`executeTalkToFigmaSessionQueue` reports `sessionHealth` with **post-execution** semantics:
- If operations executed and a post-sync succeeded, health is re-assessed from the freshly updated session metadata (should yield `active`).
- If the queue was empty or sync was skipped, health reflects the pre-execution metadata assessment.
- This ensures callers never see `stale`/`unknown` immediately after a successful run.

**Remaining limitations:**
- Health checks are metadata-only for the pre-sync gate. A session classified as "active" may still be unreachable at sync time.
- Stale threshold is configurable but not adaptive.
- No persistent health history across ensure calls.

### 6.5 Instance Override and Variant Support

Primary files:

- `src/schemas.ts`
- `src/talk-to-figma-adapter.ts`
- `plugin-example/src/figma-adapter.ts`

`create_instance` accepts three optional override fields:

| Field | Type | Figma Runtime API |
|-------|------|-------------------|
| `variantProperties` | `Record<string, string>` | `instance.setProperties()` |
| `componentProperties` | `Record<string, string \| boolean>` | `instance.setProperties()` |
| `textOverrides` | `Record<string, string>` | Child name walk + font load + `characters` |

**Override application strategy:**
- Variant and component properties are applied one-at-a-time via `setProperties()` to isolate failures.
- Text overrides walk the instance descendants, find text nodes by name, load fonts, and set `characters`.
- Both adapter paths (plugin worker and talk-to-figma websocket) implement identical logic.

**Override result shape:**
```
result.overrideResults = {
  applied: string[]     // successfully applied property names
  warnings: Array<{     // properties that could not be applied
    property: string    // e.g. "Size" or "textOverride:Label"
    reason: string      // error message
  }>
}
```

`overrideResults` is only present when at least one override was requested. If no overrides are requested, the result shape is unchanged from pre-Phase 5 behavior.

**Unsupported override behavior:** Structured warnings, not errors. The instance is always created; override failures are reported per-property in `overrideResults.warnings`.

**Remaining limitations:**
- No support for nested instance swaps (child component replacement).
- No style overrides on instance sub-nodes (fills, strokes, effects).
- Text override matching is name-based (first match), not path-based.
- `update_node` does not yet support variant/component property changes on existing instances.


## 7. Assets and Library Workflow

Primary files:

- `src/figma-assets-panel.ts`
- `src/figma-assets-workflow.ts`
- `src/figma-assets-insert-orchestrator.ts`
- `src/materialize-figma-asset.ts`
- `src/figma-rest.ts`

Responsibilities:

- scan visible asset/library UI
- search assets
- materialize instances where possible
- reconcile inserted results back into structured state

## 8. Desktop Fallback

Primary file:

- `src/desktop-agent.ts`

Responsibilities:

- OCR
- click targeting
- fallback drag or menu interactions
- screenshot-based verification

## Control Flow

### A. Structured batch execution

1. agent submits structured operations
2. server validates and resolves them
3. bridge stores the batch
4. runtime pulls the batch
5. runtime executes operations
6. runtime acknowledges results
7. runtime publishes a fresh snapshot

### B. Silent talk-to-figma execution

1. system discovers or ensures a channel
2. channel is synchronized into a bridge session
3. queued operations are translated into runtime commands
4. results are normalized into standard execution records
5. snapshot is refreshed

### C. Hybrid asset materialization

1. ensure a live runtime session
2. inspect or search visible Assets state
3. attempt instance insertion
4. synchronize the document
5. detect actual inserted nodes
6. remove accidental residue if needed

## Failure Model

The system currently assumes several failure classes:

1. runtime disconnect
2. stale channel
3. desktop focus drift
4. OCR false positives
5. partial batch completion
6. asset insertion falling back to text residue

Current mitigation strategy:

- session ensuring
- re-sync after mutation
- cleanup through silent runtime commands
- batch grouping
- explicit warnings in resolver output

## Current Gaps

### Library determinism

The Figma platform still limits deterministic full-library access. This is the largest remaining gap.

### Transaction depth

Structured transaction outcomes exist (batch status, rollback reporting, three-state operation tracking). True atomicity is still best-effort through Figma undo semantics. Dry-run support is deferred.

### Selector expressiveness

Path resolution exists but does not yet provide a rich, stable query DSL.

### Instance overrides

Instance import is stronger than before, but override depth is still incomplete.

### Observability

Structured trace records are now emitted for three key control flows (ensure-session, queue-execution, materialize-asset). Traces are stored in a ring buffer with JSON file persistence and retrievable via HTTP routes. Deeper telemetry integration (metrics, distributed tracing) is not yet implemented.

## §9 Tracing and Observability

### Trace model

Each trace record captures one control flow invocation:

- **traceId** — unique identifier (UUID)
- **parentTraceId** — links child traces to parent (e.g. materialize→ensure→queue)
- **flowType** — `ensure-session` | `queue-execution` | `materialize-asset`
- **startedAt / completedAt / durationMs** — timing data
- **status** — `succeeded` | `failed`
- **input / output** — sanitized snapshots for replay/audit
- **warnings / errors** — non-fatal and fatal messages

### Storage

- In-memory ring buffer (default 100 traces) in `TraceStore`
- Persisted to `traces.json` alongside `bridge-state.json`
- Loaded on `BridgeStore.init()`, saved via `BridgeStore.persistTraces()`

### Instrumented flows

| Flow | File | Trace emission |
|------|------|---------------|
| ensure-session | `talk-to-figma-session.ts` | At all 4 success paths + failure throw |
| queue-execution | `talk-to-figma-queue.ts` | Via `executeTalkToFigmaSessionQueueTraced()` wrapper |
| materialize-asset | `materialize-figma-asset.ts` | Via `materializeFigmaAssetTraced()` wrapper |

### HTTP retrieval routes

| Route | Description |
|-------|-------------|
| `GET /bridge/traces` | Recent traces (default limit 20, optional `?flowType=` filter) |
| `GET /bridge/traces/:traceId` | Single trace by ID |
| `GET /bridge/traces/:traceId/tree` | Trace + all descendant traces |

### Typed client methods (`PluginBridgeClient`)

| Method | Route | Returns |
|--------|-------|---------|
| `getTraces({ limit?, flowType? })` | `GET /bridge/traces` | `{ traces: TraceRecord[]; count: number }` |
| `getTrace(traceId)` | `GET /bridge/traces/:traceId` | `TraceRecord` |
| `getTraceTree(traceId)` | `GET /bridge/traces/:traceId/tree` | `{ traceId: string; tree: TraceRecord[]; count: number }` |

See `docs/TRACE_DEBUGGING.md` for usage examples.

## Recommended Next Engineering Steps

1. add richer telemetry integration (metrics, distributed tracing)
2. add multi-file session management
3. add snapshot diffing / incremental sync
4. add Figma REST API integration for team library browsing
