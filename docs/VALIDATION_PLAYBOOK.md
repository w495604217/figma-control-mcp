# Validation Playbook

## Purpose

This document defines how to validate work in `figma-control-mcp` in a way that is repeatable, auditable, and useful for release decisions.

Use this playbook when:

- finishing a phase implementation
- preparing a handoff for audit
- deciding whether a change is ready for a beta tag

## Validation Principles

1. validate the smallest changed surface first
2. separate offline validation from live-runtime validation
3. prefer explicit artifacts over verbal claims
4. test deterministic paths before fallback paths
5. record remaining limits honestly

## Validation Layers

### Layer 0: Static sanity

Use this layer immediately after implementation.

Goals:

- confirm file scope stayed contained
- confirm docs and code were both updated if behavior changed

Suggested checks:

- `git status --short`
- review changed file list
- verify public docs remain in English

### Layer 1: Local automated validation

Run this for every delivery.

Required commands:

```bash
npm test
npm run build
```

If plugin-facing code changed:

```bash
npm run typecheck:plugin
npm run build:plugin
```

Expected result:

- all commands succeed
- no skipped validation is hidden

### Layer 2: Bridge and control-plane validation

Use this when a change affects queueing, sessions, snapshots, selectors, or materialization behavior.

Suggested checks:

- start the bridge
- inspect status
- verify the intended route or CLI still behaves as documented

Example commands:

```bash
npm run dev
npm run bridge:status
```

Use phase-specific routes where relevant.

### Layer 3: Live Figma runtime validation

Use this when a change affects:

- `talk-to-figma`
- plugin worker execution
- materialization
- real instance import
- recovery after failed mutation

Suggested proof points:

- a synchronized live session
- a real mutation or import attempt
- a fresh snapshot or execution result
- evidence that the result matches the claimed strategy

Acceptable artifacts:

- CLI output
- bridge response JSON
- screenshots
- node ids or selection ids after synchronization

### Layer 4: Desktop fallback validation

Use this only if the phase touches OCR, panel scanning, or fallback imports.

You must verify:

- desktop fallback was only used where necessary
- fallback results are reported clearly
- failure and cleanup behavior are inspectable

## Required Handoff Artifacts

Every audited delivery should include:

1. changed file list
2. commands run
3. command results
4. whether validation was offline only or live-runtime as well
5. any screenshots or artifact paths
6. remaining limitations
7. release recommendation

## Phase-Specific Validation

## Phase 1: Deterministic Library Index Layer

### Required validation flow

1. run Layer 0 and Layer 1
2. inspect the library index data shape directly
3. verify that discovery output can be reused across repeated import attempts
4. verify import reports distinguish strategy type clearly
5. verify the implementation does not add new hidden desktop dependencies

### Suggested proof

- tests for library index normalization
- tests for strategy ordering
- tests for materialization decision logic
- one real or simulated import report showing distinct strategy reporting

### Required acceptance evidence

- clear evidence of reusable discovery state
- clear evidence of strategy provenance in import results
- explicit distinction between runtime import, published-key import, and desktop fallback

## Phase 2: Selector and Query Layer

### Required validation flow

1. run Layer 0 and Layer 1
2. verify selector examples against resolver output
3. verify ambiguous cases produce structured warnings before mutation

### Required acceptance evidence

- resolver tests for new selector patterns
- at least one documented example of the new selector syntax
- clear output for ambiguous or unresolved selectors

## Phase 3: Transactional Queue Semantics

### Required validation flow

1. run Layer 0 and Layer 1
2. verify dry-run behavior
3. verify partial-failure reporting
4. verify recovery semantics for interrupted or failed batches

### Required acceptance evidence

- proof that dry-run does not mutate
- proof that validation and runtime failure are distinguishable
- proof that recovery state is inspectable

## Phase 4: Session Resilience and Self-Healing

### Required validation flow

1. run Layer 0 and Layer 1
2. validate stale-session detection
3. validate recover-from-reuse-to-discover-to-launch behavior where possible

### Required acceptance evidence

- explicit health-state output
- at least one recovery scenario exercised
- honest documentation of remaining failure modes

## Phase 5: Instance Override and Variant Support

### Required validation flow

1. run Layer 0 and Layer 1
2. validate practical post-import instance manipulation
3. validate clear failure reporting for unsupported overrides

### Required acceptance evidence

- at least one successful override or variant-switch path
- at least one clearly reported unsupported path

## Phase 6: Tracing, Replay, and Observability

### Required validation flow

1. run Layer 0 and Layer 1
2. inspect generated traces or diagnostic records
3. confirm a failed run can be reasoned about from stored artifacts

### Required acceptance evidence

- trace or diagnostic artifacts
- documented replay or post-mortem flow
- proof that audits can use the stored output

## Audit Decision Rules

### Recommend `not ready` if

- tests do not pass
- docs are outdated
- the phase claim is larger than the actual implementation
- validation evidence is incomplete

### Recommend `ready for audit` if

- the implementation matches the phase scope
- required tests pass
- docs are current
- evidence is sufficient for an independent reviewer

### Recommend `ready for beta tag` only if

- the matching release gate in `docs/RELEASE_GATES.md` is satisfied
- live validation is complete where applicable
- remaining gaps are clearly documented

