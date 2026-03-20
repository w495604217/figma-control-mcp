# Implementation Plan

## Purpose

This document translates the roadmap into an implementation sequence that another agent or contributor can execute with minimal ambiguity.

It is intentionally more concrete than the product or technical spec.

Use this document when deciding:

- what to build next
- which files to touch
- what counts as “done” for a phase
- what must be validated before asking for audit or release

## Guiding Constraints

Every phase must preserve these principles:

1. runtime-first, desktop-second
2. structured state before mutation
3. deterministic operations before heuristics
4. explicit recovery behavior over hidden retries
5. honest documentation of Figma platform limits

## Phase Order

The recommended sequence is:

1. deterministic library index layer
2. selector and query layer
3. stronger transactional queue semantics
4. session resilience and self-healing
5. instance override and variant support
6. tracing, replay, and observability

This order is based on ROI, not simply on architectural purity.

## Phase 1: Deterministic Library Index Layer

### Goal

Reduce reliance on OCR and focus-sensitive Assets interactions by building a stronger library/component discovery model.

### Why this phase comes first

This is the largest practical gap between the current beta and a Pencil-like experience.

### Primary files

- `src/figma-assets-workflow.ts`
- `src/figma-assets-insert-orchestrator.ts`
- `src/figma-rest.ts`
- `src/materialize-figma-asset.ts`
- `src/bridge-store.ts`
- `src/plugin-bridge-client.ts`

### Deliverables

- a normalized in-memory representation of discovered libraries and asset candidates
- better mapping from search results to importable targets
- explicit source provenance for import attempts
- cleaner fallback ordering between runtime import, published-key import, and desktop fallback

### Out of scope

- full platform parity with every Figma library state
- perfect import reliability on every file and every operating system

### Suggested tasks

1. add a structured library index model to the bridge store
2. separate “discovery result” from “desktop click result”
3. add provenance fields such as source file, key type, runtime used, and confidence
4. make materialization select the most deterministic available path first
5. return a richer import report after every materialization attempt

### Test expectations

- unit tests for index normalization
- unit tests for ranking fallback strategies
- integration tests for materialization decision paths

### Acceptance criteria

- one asset search can be reused across follow-up import attempts
- import reports clearly show which strategy succeeded or failed
- common import workflows succeed more often without manual correction

## Phase 2: Selector and Query Layer

### Goal

Make node targeting stable and programmable without forcing every workflow to depend on raw node ids.

### Primary files

- `src/batch-resolver.ts`
- `src/schemas.ts`
- `src/server.ts`
- `tests/batch-resolver.test.ts`

### Deliverables

- richer selector grammar
- clearer ambiguity diagnostics
- explicit resolution metadata
- support for more repeatable automation prompts

### Suggested tasks

1. extend path syntax beyond simple name and index traversal
2. support more typed filtering and scoped lookup
3. produce structured ambiguity warnings instead of vague failures
4. improve resolver error messages for agent consumption

### Out of scope

- free-form natural language selector parsing
- arbitrary fuzzy matching with no confidence model

### Acceptance criteria

- common updates can target nodes without raw ids
- resolver output makes ambiguity visible before enqueue
- agent prompts can use repeatable selectors in scripted workflows

## Phase 3: Stronger Transactional Queue Semantics

### Goal

Improve execution safety with better preflight behavior, rollback semantics, and batch guarantees.

### Primary files

- `src/operation-executor.ts`
- `src/queue-executor.ts`
- `src/talk-to-figma-queue.ts`
- `src/bridge-store.ts`

### Deliverables

- dry-run support
- clearer batch execution records
- stronger rollback semantics
- better partial-failure reporting

### Suggested tasks

1. add dry-run support at the queue-execution layer
2. record preflight validation results separately from mutation results
3. improve execution records with phase, failure mode, and recovery outcome
4. add stronger handling for interrupted or partially applied batches

### Acceptance criteria

- a caller can request dry-run without mutating the document
- batch records distinguish validation failure from runtime failure
- recovery paths are inspectable after a failed run

## Phase 4: Session Resilience and Self-Healing

### Goal

Make long-running sessions more trustworthy and less fragile.

### Primary files

- `src/talk-to-figma-session.ts`
- `src/talk-to-figma-sync.ts`
- `src/talk-to-figma.ts`
- `src/bridge-http.ts`

### Deliverables

- more reliable reconnect behavior
- stronger stale-session detection
- explicit health model for live sessions
- more predictable fallback from existing session to discover to launch

### Acceptance criteria

- the system can recover from common stale-session cases automatically
- callers receive explicit health and recovery signals
- repeated use across a long session becomes more stable

## Phase 5: Instance Override and Variant Support

### Goal

Move from “can import an instance” to “can actually work with design-system instances”.

### Primary files

- `src/talk-to-figma-adapter.ts`
- `plugin-example/src/figma-adapter.ts`
- `src/schemas.ts`
- `src/operation-executor.ts`

### Deliverables

- variant switching support
- stronger instance override support
- safer text and property overrides inside instances
- clearer reporting for unsupported override paths

### Acceptance criteria

- imported instances can be meaningfully customized
- unsupported override patterns fail clearly instead of silently
- instance workflows feel closer to real design-system usage

## Phase 6: Tracing, Replay, and Observability

### Goal

Make the system easier to debug, audit, and extend.

### Primary files

- `src/bridge-store.ts`
- `src/bridge-http.ts`
- `src/queue-executor.ts`
- `src/materialize-figma-asset.ts`

### Deliverables

- richer action logs
- replayable execution traces
- structured diagnostics for failed runs
- better screenshots or artifact references for desktop fallback cases

### Acceptance criteria

- failed runs are diagnosable without reproducing them manually
- contributors can inspect what happened in a previous run
- audit reviews can reason about behavior using stored traces

## Required Deliverable Format For Each Phase

When implementing any phase, the delivery should include:

1. a concise summary of the capability added
2. a file list of intentional changes
3. tests added or updated
4. commands run locally
5. known limitations after the change
6. a short release recommendation: not ready, ready for audit, or ready for beta tag

## Audit Trigger

A phase should be handed off for audit only when:

- tests pass
- docs are updated
- the working tree is clean
- the implementation matches the acceptance criteria for that phase

