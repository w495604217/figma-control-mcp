# Figma Control MCP

Figma Control MCP is a hybrid control layer for Figma that aims to feel closer to Pencil MCP than to a read-only design-context bridge.

Instead of treating Figma as a webpage to click through, this project combines:

- structured MCP tools
- a local HTTP bridge
- a Figma plugin worker
- `talk-to-figma` websocket compatibility
- desktop fallback for the parts of Figma that the Plugin API still does not expose

The result is a system that can read, plan, execute, verify, and recover changes inside a live Figma file with much stronger determinism than DOM automation alone.

## Project Status

This repository is currently published as `0.0.1-beta`.

That means:

- the core architecture is real and working
- silent canvas control is already usable
- live asset discovery and import are partially solved through a hybrid strategy
- the library layer is still constrained by current Figma platform limits

This is not yet a full Pencil-equivalent implementation, but it is already a practical beta for real design automation workflows.

## What This Project Is

This project is a **Pencil-like hybrid MCP control system for Figma**.

It is designed for workflows where an AI agent needs to:

- inspect a live Figma file
- synchronize page state into a structured snapshot
- enqueue deterministic node operations
- execute those operations silently through a Figma runtime
- fall back to desktop automation only when the Figma Plugin API does not expose a required capability
- recover from partial failure and re-sync the file state

## What This Project Is Not

This project is not:

- the official Figma MCP server
- a simple browser automation script
- a DOM scraper for `figma.com`
- a complete replacement for every Pencil MCP feature today

The key difference is architectural:

1. agents operate on structured state, not blind clicks
2. Figma execution happens through a plugin/runtime channel whenever possible
3. desktop automation is an explicit fallback, not the primary control plane

## Why This Exists

Figma already has good solutions for:

- design context extraction
- screenshots
- code-connect mapping
- design-to-code assistance

What is still missing is a reliable, programmable, agent-friendly control layer that can get closer to:

- batched operations
- predictable node updates
- execution acknowledgment
- session recovery
- post-operation verification

That gap is what this repository targets.

## Core Architecture

```text
LLM Agent
   |
   v
Figma Control MCP Server
   |
   | queue / snapshot / execution intent
   v
Local HTTP Bridge
   |
   +--------------------+
   |                    |
   v                    v
Figma Plugin Worker   talk-to-figma Relay
   |                    |
   +---------+----------+
             |
             v
        Figma Runtime
             |
             v
   Desktop Fallback (OCR / click / drag)
   only where Figma APIs stop
```

## Implemented in `0.0.1-beta`

### Core bridge and session model

- MCP server with deterministic tool surface
- local HTTP bridge for plugin and local tooling
- persisted bridge state
- session registration and snapshot publishing
- operation queueing and acknowledgment
- live status inspection

### Structured execution

- batch enqueueing with shared `batchId`
- path resolution before enqueue
- queue execution against a Figma runtime
- automatic re-sync after queue execution
- batch-aware queue pulling
- partial rollback strategy through Figma undo semantics

### Node operations

- `create_node`
- `create_instance`
- `update_node`
- `delete_node`
- `move_node`
- `set_selection`
- `set_variable`
- plugin action execution

Current `create_node` coverage:

- `FRAME`
- `TEXT`
- `RECTANGLE`
- `ELLIPSE`
- `COMPONENT`
- `SECTION`

### Hybrid runtime support

- direct plugin-worker execution
- `talk-to-figma` websocket compatibility
- channel probing and discovery
- channel-to-session synchronization
- automatic session ensuring with launch/discover fallback
- queue execution through a live `talk-to-figma` session

### Asset and library workflow

- search live session component catalogs
- scan the visible Assets panel with desktop OCR
- search Assets panel results
- attempt asset materialization into the current file
- normalize the result back into structured snapshots
- recover from common text-insertion failure modes

## Current Practical Capability

In the current beta, the system can already do all of the following in real workflows:

- connect to a live Figma file
- read page structure and selection state
- apply silent canvas mutations
- build or refactor multi-screen interfaces
- import at least some real library instances
- verify outcomes through re-synchronization
- clean up accidental OCR-driven text residue

## Known Platform Limits

The main blocker between this beta and a full Pencil-level replacement is not only implementation work. Part of it is the Figma platform boundary itself.

Important examples:

- the Figma Plugin API does not currently expose full deterministic library enumeration
- enabling or browsing every library state through the Plugin API is still limited
- some asset import workflows still require a desktop fallback

Because of that, this project uses a layered strategy:

1. use plugin/runtime control first
2. use websocket relay when available
3. use desktop fallback only when required

## Installation

### Requirements

- Node.js 20+
- Figma Desktop
- a local Figma plugin development workflow
- macOS for the current desktop fallback implementation

### Setup

```bash
npm install
npm run test
npm run build
npm run typecheck:plugin
npm run build:plugin
```

### Start the bridge

```bash
npm run dev
```

Default state file:

```text
<project>/.figma-control-mcp/bridge-state.json
```

Override it if needed:

```bash
FIGMA_CONTROL_MCP_STATE_PATH=/absolute/path/to/bridge-state.json npm run dev
```

Default bridge address:

```text
http://127.0.0.1:3847
```

Useful environment variables:

```bash
FIGMA_CONTROL_BRIDGE_PORT=3847
FIGMA_CONTROL_BRIDGE_TOKEN=change-me
FIGMA_CONTROL_TALK_TO_FIGMA_WS_URL=ws://127.0.0.1:3055
FIGMA_CONTROL_TALK_TO_FIGMA_LOG_PATH=/private/tmp/figma-ws.log
```

## Plugin Worker

The repository ships with a development plugin example under [plugin-example/README.md](plugin-example/README.md).

The plugin worker can:

- register a session
- publish a snapshot
- pull operations
- execute them in Figma
- acknowledge results
- loop as a lightweight worker

## HTTP API Surface

### Health and status

- `GET /healthz`
- `GET /bridge/status`
- `GET /bridge/components`

### Core bridge operations

- `POST /bridge/register-session`
- `POST /bridge/snapshot`
- `POST /bridge/resolve-batch`
- `POST /bridge/enqueue-batch`
- `POST /bridge/pull-operations`
- `POST /bridge/acknowledge`

### talk-to-figma integration

- `GET /bridge/talk-to-figma/channels`
- `POST /bridge/talk-to-figma/probe`
- `POST /bridge/talk-to-figma/command`
- `POST /bridge/talk-to-figma/sync`
- `POST /bridge/talk-to-figma/ensure-session`
- `POST /bridge/talk-to-figma/run-queue`

### Asset workflow

- `POST /bridge/materialize-asset`

### Development plugin launch helpers

- `GET /bridge/figma/development-plugins`
- `POST /bridge/figma/launch-development-plugin`
- `POST /bridge/figma/launch-and-discover-talk-to-figma`

## Path Syntax

The resolver currently supports path-based addressing in addition to raw `nodeId`.

Examples:

- `Hero`
- `Hero/Button`
- `Hero/Button[2]`
- `#12:34`

Rules:

- `/` means parent-child traversal
- `[n]` means the `n`th sibling with the same visible name, starting from `1`
- `#id` means direct lookup by Figma node id

## CLI Examples

Start the bridge:

```bash
npm run dev
```

Resolve a batched request first:

```bash
npm run bridge:resolve -- ./examples/update-hero-button.json
```

Then enqueue it:

```bash
npm run bridge:enqueue -- ./examples/update-hero-button.json
```

Check current status:

```bash
npm run bridge:status -- <sessionId>
```

Search live components:

```bash
npm run bridge:components -- Button
```

Probe a `talk-to-figma` channel:

```bash
npm run bridge:talk-probe -- <channel>
```

List recent channels from a relay log:

```bash
npm run bridge:talk-channels -- 10 /private/tmp/figma-ws.log
```

Launch a development plugin from the Figma menu:

```bash
npm run bridge:figma-launch-plugin -- "Cursor MCP Plugin"
```

Launch and discover a live channel:

```bash
npm run bridge:figma-launch-discover -- "Cursor MCP Plugin" ws://127.0.0.1:3055 /private/tmp/figma-ws.log
```

Synchronize a live channel into a bridge session:

```bash
npm run bridge:talk-sync -- <channel>
```

Ensure a reusable talk session:

```bash
npm run bridge:talk-ensure -- <sessionId>
```

Run a queued operation batch through a talk session:

```bash
npm run bridge:talk-run-queue -- <sessionId>
```

Execute a raw silent command:

```bash
npm run bridge:talk-command -- <channel> get_document_info
```

Execute a silent command with params:

```bash
npm run bridge:talk-command -- <channel> create_frame @./examples/talk-to-figma-create-frame.json
```

Scan visible libraries from the Assets panel:

```bash
npm run bridge:assets
```

Search the Assets panel:

```bash
npm run bridge:asset-search -- "Toolbar"
```

## Roadmap

See [ROADMAP.md](ROADMAP.md).

## Product and Technical Specs

- [docs/PRD.md](docs/PRD.md)
- [docs/TECH_SPEC.md](docs/TECH_SPEC.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).

Run the full hybrid chain to materialize an asset, place it on the canvas, and automatically select the inserted result:

```bash
npm run bridge:materialize-asset -- Toolbar talk-to-figma:x2lmbp3m
```

If you do not want to provide a session manually, you can also call the HTTP route and let it discover a session automatically:

```bash
curl -s -X POST http://127.0.0.1:3847/bridge/materialize-asset \
  -H 'content-type: application/json' \
  -d '{"query":"Toolbar","dryRun":true}'
```

Notes:

- this is a desktop OCR scan and does not depend on the Figma Plugin API
- it is useful for answering questions like “which kits are currently visible in the Figma app”
- OCR output may contain minor spelling noise, but it is usually good enough for follow-up clicking and search candidate generation

## Current Completion Level

- silent in-canvas control: usable
- `talk-to-figma` probing, discovery, synchronization, and queued execution: usable
- visible-library scanning from the Assets panel: usable
- Assets search: usable
- one-shot asset materialization with `materialize_figma_asset`: usable
- automatic selection and synchronization of inserted results: usable
- the biggest remaining real-world boundary is that Figma still does not expose a full deterministic API for library enumeration and enablement, so desktop fallback is still required in that area

## Recommended Next Work

To move closer to a true Pencil-like control surface, the next expansions should happen in roughly this order:

1. extend node-type coverage and patch whitelists so fewer requested fields are ignored
2. add dry-run and capability probing so an agent can know what is executable before mutating the document
3. improve selector power and ambiguity reporting in the path resolver
4. add stronger batch recovery semantics beyond undo-only rollback
5. add a design-AST diff layer to support safer incremental operations

For the detailed plugin integration contract, see:

- `docs/plugin-bridge-contract.md`
- `plugin-example/README.md`
- `examples/update-hero-button.json`
- `examples/create-footer-cta.json`

## Minimal Plugin Bridge Workflow

1. the plugin starts and calls `register_figma_session`
2. the plugin captures a lightweight page graph and calls `publish_figma_snapshot`
3. the agent calls `enqueue_figma_operations`
4. the plugin polls `pull_figma_operations`
5. the plugin executes operations through the Figma Plugin API
6. the plugin calls `acknowledge_figma_operations`
7. the plugin publishes a fresh snapshot again through `publish_figma_snapshot`

## Cross-Kit Import Workflow

1. start a worker in the source kit file so it can publish the kit’s component catalog into the bridge
2. use `search_live_figma_components` or `npm run bridge:components` to find the target `componentKey`
3. in the target project file, enqueue a `create_instance` operation for the target session
4. the plugin imports the component with `importComponentByKeyAsync` and creates the instance directly in the target file

## Why This Direction Is Closer to Pencil

- it is not based primarily on OCR or browser clicking
- in-canvas mutations can already run through silent websocket commands without fighting the user for mouse control
- structured enqueue and batch execution can already target a `talk-to-figma` session directly instead of requiring handwritten raw websocket commands
- desktop automation is reserved for areas the official API still does not expose, such as library discovery in the Assets panel
- plugin launch itself can already be automated through the macOS menu layer instead of depending on quick-action search
- it is not based on DOM guessing
- every operation has a structured result
- the architecture can support idempotency, retries, rollback, and diffing
- it can gradually evolve into a true Figma AST control layer
