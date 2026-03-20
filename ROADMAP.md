# Roadmap

## Positioning

The goal is not to claim feature parity too early.

The goal is to move from:

- a strong hybrid beta

to:

- a practically replaceable Pencil-like control layer for Figma

## Version Plan

## `0.0.1-beta`

Focus:

- publish the working architecture
- document the hybrid model
- prove real canvas control and real library-instance usage

Expected outcomes:

- public repository
- setup docs
- plugin worker example
- working bridge and CLI
- beta roadmap and specs

## `0.0.2-beta`

Focus:

- stabilize asset discovery and insertion
- reduce accidental text insertion failures
- improve cleanup and post-insert verification

Expected outcomes:

- stronger asset materialization workflow
- fewer OCR-driven failure cases
- improved import validation

## `0.0.3-beta`

Focus:

- path-based selectors and query ergonomics
- better node targeting without raw ids

Expected outcomes:

- more stable selector grammar
- more expressive node resolution
- better support for repeatable automation scripts

## `0.0.4-beta`

Focus:

- transactional queue semantics
- dry-run, rollback, and better execution safety

Expected outcomes:

- preflight validation
- better batch isolation
- clearer failure recovery guarantees

## `0.1.0-beta`

Focus:

- practical replaceability for real-world Figma automation

Expected outcomes:

- session self-healing
- stronger instance override support
- improved observability
- stronger import workflows
- clear acceptance criteria for “production beta”

## High-ROI Workstreams

### 1. Library Index Layer

This is the biggest practical gap today.

Why it matters:

- reduces dependence on OCR and window focus
- moves the system closer to deterministic imports
- improves the “Pencil-like” feeling more than most other work

### 2. Stable Selector Layer

Why it matters:

- makes the system programmable instead of merely operable
- lowers the cost of automation prompts and generated plans

### 3. Transaction Layer

Why it matters:

- makes autonomous runs safer
- reduces dirty states after failure
- enables better auditing and staged execution

### 4. Instance Override Layer

Why it matters:

- importing an instance is not enough
- real design workflows need variant switching and override control

### 5. Session Resilience

Why it matters:

- reduces friction in long-running agent workflows
- improves trust in autonomous operation

### 6. Tracing and Replay

Why it matters:

- makes debugging and contribution far easier
- creates a better open-source collaboration surface

