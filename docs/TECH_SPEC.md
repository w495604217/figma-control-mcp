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

Batch semantics exist, but a full dry-run plus explicit compensation transaction layer is not complete yet.

### Selector expressiveness

Path resolution exists but does not yet provide a rich, stable query DSL.

### Instance overrides

Instance import is stronger than before, but override depth is still incomplete.

### Observability

The system still needs stronger trace logs, replay tooling, and execution diagnostics.

## Recommended Next Engineering Steps

1. build a stronger library index layer
2. expand selector grammar
3. add richer transactional guarantees
4. add instance override support
5. add health and replay tooling

