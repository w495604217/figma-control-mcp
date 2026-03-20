# Release Gates

## Purpose

This document defines the release criteria for each beta checkpoint.

It should be used as the audit checklist before tagging or promoting a version.

## General Rules

Every release candidate must satisfy all of the following:

1. all public repository content is in English
2. `npm test` passes
3. `npm run build` passes
4. `npm run typecheck:plugin` passes
5. `npm run build:plugin` passes
6. the working tree is clean
7. README and relevant specs reflect the actual behavior

## `0.0.2-beta` Gate

### Theme

Library discovery and import stability.

### Required capabilities

- stronger asset materialization workflow
- fewer false-positive text insertions
- clearer import result reporting
- cleaner fallback ordering between strategies

### Required validation

- unit tests for discovery or materialization decision logic
- at least one verified real library import workflow
- documented known gaps if any import path still depends on desktop fallback

### Reject if

- imports still fail silently
- the system cannot explain which strategy it used
- cleanup logic is hidden or unreliable

## `0.0.3-beta` Gate

### Theme

Selector and query ergonomics.

### Required capabilities

- richer path or selector grammar
- better ambiguity reporting
- reduced dependence on raw node ids for common flows

### Required validation

- resolver tests covering new selector cases
- examples or docs showing the new selector usage

### Reject if

- selector behavior is undocumented
- ambiguity still results in unclear runtime failures

## `0.0.4-beta` Gate

### Theme

Transactional execution safety.

### Required capabilities

- dry-run support
- stronger batch reporting
- better rollback behavior or equivalent safety handling

### Required validation

- tests for dry-run behavior
- tests or fixtures for mid-batch failure handling
- explicit execution record shape for success, failure, and recovery

### Reject if

- dry-run mutates the document
- partial failure remains opaque

## `0.1.0-beta` Gate

### Theme

Practical Pencil-like replaceability.

### Required capabilities

- reliable session ensuring and recovery
- meaningful instance override support
- stronger observability and traceability
- practical asset import flow for real design work

### Required validation

- real workflow validation on a live Figma file
- documented recovery behavior
- clear boundaries for still-unsupported platform cases
- public docs updated to match the achieved scope honestly

### Reject if

- session recovery is still too fragile for repeated use
- instance handling is import-only with no meaningful follow-up control
- the release claims full parity that the code does not support

## Audit Checklist Template

Use the following review structure before each release:

1. What changed
2. What was validated
3. What is still not solved
4. Which release gate is being claimed
5. Whether the claim is accepted or rejected

