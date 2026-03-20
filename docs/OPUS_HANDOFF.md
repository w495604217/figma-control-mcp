# Opus Handoff Guide

## Mission

Your job is to continue implementation work on Figma Control MCP without blurring the architectural boundaries that make the project valuable.

This repository is not trying to become a pile of desktop hacks.

It is trying to become a Pencil-like hybrid MCP control layer for Figma by preserving the following order of preference:

1. Figma runtime execution
2. structured synchronization
3. websocket-backed silent control
4. desktop fallback only where the Figma platform still blocks deterministic access

## Core Rules

1. Do not claim a capability that the code does not actually support.
2. Do not hide Figma platform limitations behind vague abstractions.
3. Prefer deterministic imports and selectors over convenience heuristics.
4. Do not move more responsibility into desktop fallback than necessary.
5. Keep all public repository content in English.
6. Update docs whenever the behavior surface changes.

## Recommended Work Order

Implement phases in this order:

1. deterministic library index layer
2. selector and query layer
3. transactional queue semantics
4. session resilience
5. instance override support
6. tracing and replay

Use these references:

- [docs/IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
- [docs/RELEASE_GATES.md](RELEASE_GATES.md)
- [docs/VALIDATION_PLAYBOOK.md](VALIDATION_PLAYBOOK.md)
- [docs/TECH_SPEC.md](TECH_SPEC.md)
- [ROADMAP.md](../ROADMAP.md)

## How To Approach A Phase

For each phase:

1. read the implementation plan section for that phase
2. identify the exact files that should change
3. keep the scope tight
4. add or update tests
5. update user-facing and contributor-facing docs if the behavior changes
6. run validation commands before handing off for audit

## Required Output Format For Every Delivery

Every implementation handoff should include:

### 1. Summary

A short description of what was added or changed.

### 2. File list

A list of files changed intentionally.

### 3. Validation

Commands run locally, for example:

```bash
npm test
npm run build
npm run typecheck:plugin
npm run build:plugin
```

### 4. Remaining gaps

A short list of what still does not work or is still platform-limited.

### 5. Release recommendation

Choose one:

- not ready
- ready for audit
- ready for beta tag

## Anti-Patterns

Avoid the following:

- turning the bridge into a browser automation wrapper
- adding undocumented magical fallback behavior
- using desktop clicks when a runtime path already exists
- introducing selector behavior that cannot be explained or tested
- merging broad speculative changes across multiple phases

## When To Ask For Audit

Ask for audit only when:

- the phase scope is complete
- tests pass
- docs are updated
- you can map the change to one release gate
- you can explain the exact remaining risk

## Audit Expectations

An audit will check:

- whether the implementation matches the claimed phase
- whether release criteria are actually satisfied
- whether unsupported behavior is still being described honestly
- whether the code increases or decreases the project’s determinism

## Preferred Contribution Style

Good contributions:

- sharpen one architectural layer
- improve determinism
- improve observability
- reduce manual recovery
- reduce dependence on focus-sensitive fallback

Weak contributions:

- make a demo look better without improving the control plane
- add undocumented shortcuts
- increase apparent capability while reducing reliability
