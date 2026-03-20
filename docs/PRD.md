# Product Requirements Document

## Product Name

Figma Control MCP

## Summary

Figma Control MCP is a hybrid control layer that allows an AI agent to operate on a live Figma file through structured state, deterministic execution, and selective desktop fallback.

The product exists to close the gap between:

- read-only Figma context tools
- fragile browser automation
- and the more complete control experience users expect from Pencil MCP

## Problem Statement

Current Figma automation approaches usually break into one of three categories:

1. read-only context extraction
2. DOM-level automation with weak guarantees
3. custom one-off plugin scripts without a reusable control plane

These approaches are not enough for a serious agent workflow because they lack one or more of the following:

- persistent session state
- deterministic node execution
- structured acknowledgments
- reliable re-synchronization
- controlled fallback behavior when the Figma API stops

## Product Goal

Build a practical Pencil-like control surface for Figma that enables an AI agent to:

- inspect a live document
- plan node-level operations
- execute those operations through a stable runtime
- verify outcomes
- recover from common failure modes

## Non-Goals for `0.0.1-beta`

- full platform parity with Pencil MCP
- full deterministic enumeration of every external library in Figma
- complete elimination of desktop fallback
- perfect cross-platform support

## Target Users

### Primary users

- AI-agent builders
- design engineers
- automation engineers
- developers who want Figma to behave more like a programmable scene graph

### Secondary users

- research teams prototyping autonomous design workflows
- plugin engineers building on top of a bridge layer
- contributors exploring better library import strategies

## Core User Stories

1. As an agent developer, I want to synchronize a live Figma page into structured state so I can reason before acting.
2. As an agent developer, I want to enqueue deterministic operations so the runtime does not rely on blind UI clicking.
3. As a workflow designer, I want the system to recover from partial failures and resync the file.
4. As a designer or engineer, I want to import real library instances when possible, not approximate mock components.
5. As a contributor, I want clear module boundaries so I can improve one layer without rewriting everything.

## Success Criteria

The product is successful when an AI agent can complete real design tasks in Figma with:

- predictable canvas mutations
- verifiable state synchronization
- limited manual intervention
- acceptable recovery after failure

## Acceptance Criteria by Capability

### Live session control

- can establish or recover a live Figma session
- can synchronize the current page into a snapshot
- can inspect selection state and page metadata

### Deterministic execution

- can enqueue node operations
- can execute those operations against the live file
- can acknowledge execution results
- can resync after execution

### Asset flow

- can discover at least some asset/library options in a live workflow
- can import at least some real library instances
- can normalize the result back into structured state

### Recovery

- can detect partial failure
- can clean up common accidental text artifacts
- can restore a clean synchronized state after recovery

## Key Risks

1. Figma platform limits around library enumeration
2. desktop fallback fragility
3. plugin lifecycle instability
4. divergence between visible UI state and synchronized structured state

## Beta Release Definition

We consider `0.0.1-beta` valid if all of the following are true:

- the repository is publicly understandable
- installation and setup are reproducible
- the architecture is clearly documented
- the bridge and plugin worker build successfully
- the current limitations are explicit and honest

