# Opus Start Prompt

Use the following prompt as the first-turn bootstrap prompt for Opus when continuing work on this repository.

---

You are continuing work on the repository `figma-control-mcp`.

Local repository path:

`<your-local-path>/figma-control-mcp`

Repository URL:

`https://github.com/w495604217/figma-control-mcp`

Your mission is to continue implementation toward `0.1.0-beta` without violating the project’s architectural boundaries.

This project is not a generic browser automation script. It is a Pencil-like hybrid MCP control layer for Figma. The system must always prefer:

1. Figma runtime execution
2. structured synchronization
3. websocket-backed silent control
4. desktop fallback only where the Figma platform still blocks deterministic access

## Required Reading Order

Before you write code, read these documents in order:

1. `README.md`
2. `docs/PRD.md`
3. `docs/TECH_SPEC.md`
4. `docs/IMPLEMENTATION_PLAN.md`
5. `docs/RELEASE_GATES.md`
6. `docs/OPUS_HANDOFF.md`

Also inspect the current GitHub milestone and issues for `0.1.0-beta`.

## Global Rules

1. Keep all public repository content in English.
2. Do not claim support for capabilities that are not actually implemented.
3. Do not hide Figma platform limits behind vague abstractions.
4. Prefer deterministic behavior over clever heuristics.
5. Do not move more responsibility into desktop fallback than necessary.
6. Keep docs, tests, and code in sync.
7. Treat every phase as an auditable delivery.

## Work Sequence

Implement the roadmap in this order:

1. deterministic library index layer
2. selector and query layer
3. stronger transactional queue semantics
4. session resilience and self-healing
5. instance override and variant support
6. tracing, replay, and observability

## First Phase To Start Now

Start with:

`Issue #1 - Build a deterministic library index layer`

Do not start multiple phases at once.

---

## Phase Workflow

For every phase, follow this exact workflow:

### Step 1: Reconfirm scope

- restate the phase goal
- list the files you expect to change
- list what is explicitly out of scope

### Step 2: Inspect current implementation

- read the relevant source files
- identify current limitations
- identify what already exists that should be reused

### Step 3: Propose a small execution slice

- define the smallest valuable increment that advances the phase
- prefer shipping one coherent improvement rather than a broad mixed patch

### Step 4: Implement

- make focused code changes
- preserve architectural separation between runtime, bridge, session, and desktop fallback
- avoid speculative refactors outside the phase

### Step 5: Test

At minimum run:

```bash
npm test
npm run build
```

If plugin-facing code changes:

```bash
npm run typecheck:plugin
npm run build:plugin
```

### Step 6: Update docs

Update any affected public documentation if:

- behavior changed
- a new workflow was introduced
- a limit was removed
- a new limit became explicit

### Step 7: Deliver for audit

Your handoff must include:

1. summary of changes
2. exact file list
3. commands run
4. test results
5. remaining limitations
6. release recommendation:
   - not ready
   - ready for audit
   - ready for beta tag

---

## Phase-by-Phase Requirements

## Phase 1: Deterministic Library Index Layer

### Goal

Reduce dependence on OCR and focus-sensitive Assets interactions by building a stronger library and component discovery model.

### Primary files

- `src/figma-assets-workflow.ts`
- `src/figma-assets-insert-orchestrator.ts`
- `src/figma-rest.ts`
- `src/materialize-figma-asset.ts`
- `src/bridge-store.ts`
- `src/plugin-bridge-client.ts`

### Required flow

1. inspect current library and asset materialization flow
2. define a normalized library-index shape
3. separate discovery data from click execution data
4. improve how search results map to importable targets
5. improve import reporting and provenance
6. add tests for the new index and decision path
7. update docs if the public workflow changed

### Acceptance criteria

- asset discovery results can be reused across follow-up import attempts
- import attempts clearly report which strategy was used
- import reports distinguish runtime import, published-key import, and desktop fallback
- the implementation reduces hidden OCR dependence instead of increasing it

### Reject conditions

- the patch adds more opaque desktop automation without stronger structure
- import results are still hard to reason about
- no tests are added for the new decision logic

## Phase 2: Selector and Query Layer

### Goal

Make node targeting more expressive and stable without requiring raw node ids for routine work.

### Primary files

- `src/batch-resolver.ts`
- `src/schemas.ts`
- `src/server.ts`
- `tests/batch-resolver.test.ts`

### Required flow

1. inspect current path grammar and failure modes
2. design an incremental selector extension
3. implement structured ambiguity reporting
4. extend resolver tests
5. update documentation and examples

### Acceptance criteria

- common workflows can target nodes without raw ids
- ambiguity is surfaced before mutation
- resolver output is clear enough for an agent to act on

### Reject conditions

- selector behavior is undocumented
- ambiguity still leads to unclear runtime failure
- implementation depends on unbounded fuzzy matching

## Phase 3: Stronger Transactional Queue Semantics

### Goal

Improve batch safety with dry-run, richer execution records, and better recovery semantics.

### Primary files

- `src/operation-executor.ts`
- `src/queue-executor.ts`
- `src/talk-to-figma-queue.ts`
- `src/bridge-store.ts`

### Required flow

1. inspect current batch model and failure handling
2. introduce a dry-run or equivalent preflight pathway
3. distinguish validation errors from runtime errors
4. improve execution records for partial failure and recovery
5. add tests covering dry-run and failure paths

### Acceptance criteria

- callers can validate a batch without mutating the document
- batch records distinguish validation failure from runtime failure
- failure and recovery paths are inspectable after a run

### Reject conditions

- dry-run still mutates the document
- partial failures remain opaque
- recovery behavior is undocumented

## Phase 4: Session Resilience and Self-Healing

### Goal

Make live sessions more reliable across longer autonomous runs.

### Primary files

- `src/talk-to-figma-session.ts`
- `src/talk-to-figma-sync.ts`
- `src/talk-to-figma.ts`
- `src/bridge-http.ts`

### Required flow

1. inspect current session lifecycle behavior
2. define clearer health states
3. improve stale-session detection
4. strengthen recover-from-reuse-to-discover-to-launch behavior
5. add tests or diagnostics for the new health logic

### Acceptance criteria

- stale session cases recover more predictably
- callers receive explicit session-health signals
- repeated use in longer workflows becomes more stable

### Reject conditions

- recovery remains mostly implicit
- the patch adds retries without visibility

## Phase 5: Instance Override and Variant Support

### Goal

Make imported design-system instances meaningfully editable after import.

### Primary files

- `src/talk-to-figma-adapter.ts`
- `plugin-example/src/figma-adapter.ts`
- `src/schemas.ts`
- `src/operation-executor.ts`

### Required flow

1. inspect current instance import and post-import behavior
2. define a minimal override model
3. support meaningful overrides and variant switching where possible
4. add tests and clear unsupported-path reporting
5. update docs and examples

### Acceptance criteria

- imported instances can be customized in practical ways
- unsupported override paths fail clearly
- the behavior is documented honestly

### Reject conditions

- silent no-op behavior on unsupported override paths
- broad claims without verified support

## Phase 6: Tracing, Replay, and Observability

### Goal

Make the system easier to debug, audit, and extend.

### Primary files

- `src/bridge-store.ts`
- `src/bridge-http.ts`
- `src/queue-executor.ts`
- `src/materialize-figma-asset.ts`

### Required flow

1. inspect current logging and diagnostics
2. define a minimal trace model
3. add richer execution artifacts
4. support replay or equivalent diagnostic reconstruction where practical
5. document how traces are used during audit

### Acceptance criteria

- failed runs are diagnosable without full manual reproduction
- contributors can inspect what happened in a previous run
- audits can reason about behavior using stored traces

### Reject conditions

- tracing is added but not documented
- logs exist but still do not explain failure paths

---

## Required Validation Gates Before Asking For Audit

Before you hand off any phase, all of the following must be true:

1. public repository content remains in English
2. `npm test` passes
3. `npm run build` passes
4. if plugin-facing code changed, `npm run typecheck:plugin` passes
5. if plugin-facing code changed, `npm run build:plugin` passes
6. docs reflect the actual capability surface
7. the working tree is clean

## Final Instruction

Start with `Issue #1`.

Do not try to solve the whole roadmap in one pass.

Finish one phase properly, validate it, document it, and hand it off for audit.

---

End of prompt.
