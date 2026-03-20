# Figma Plugin Example

This folder contains the reference plugin worker for `figma-control-mcp`.

The worker is intentionally small. Its job is to bridge the local MCP/HTTP control plane to the Figma Plugin API.

## Responsibilities

The plugin worker can:

1. register a Figma session with the local bridge
2. publish a lightweight snapshot of the current document state
3. pull queued operations
4. execute those operations inside the Figma runtime
5. acknowledge execution results
6. publish a fresh snapshot after execution

## Supported Operations

- `create_node`
- `create_instance`
- `update_node`
- `delete_node`
- `move_node`
- `set_selection`
- `set_variable`
- `run_plugin_action: scroll_into_view`

Current `create_node` coverage:

- `FRAME`
- `TEXT`
- `RECTANGLE`
- `ELLIPSE`
- `COMPONENT`
- `SECTION`

Current `create_instance` support:

- instantiate a published component by `componentKey`
- instantiate a local component by `componentId`

## Execution Semantics

- operations are grouped by `batchId`
- a pulled batch is executed in order as one unit
- if every operation succeeds, the batch is treated as one logical edit step
- if a batch fails midway, the worker attempts to roll back through Figma undo semantics
- the bridge avoids splitting one batch across multiple pulls

## Build

```bash
npm run build:plugin
```

Build output:

```text
plugin-dist/
```

Generated files:

- `code.js`
- `manifest.json`
- `ui.html`

## Import Into Figma

1. start the local bridge

```bash
npm run dev
```

2. build the plugin

```bash
npm run build:plugin
```

3. open Figma Desktop
4. choose `Plugins` -> `Development` -> `Import plugin from manifest...`
5. select:

```text
<project>/figma-control-mcp/plugin-dist/manifest.json
```

## Available Commands

- `Start Worker`
  - starts the long-running hidden worker loop
- `Sync Once`
  - performs one registration, snapshot, operation pass, and exit

## Current Limits

- the default bridge URL is `http://127.0.0.1:3847`
- the manifest allows both `127.0.0.1` and `localhost` for development compatibility
- if you enable `FIGMA_CONTROL_BRIDGE_TOKEN`, update the bridge auth handling in `plugin-example/src/code.ts`
- variable operations currently assume the target variable already exists
- path resolution happens on the bridge side; the plugin receives resolved node-level operations
- rollback still depends primarily on Figma undo behavior rather than a fully independent compensation layer
- the Figma Plugin API still cannot fully enumerate or enable all Assets-panel libraries, so desktop fallback remains necessary in some workflows

## Why This Is Stronger Than Pure DevTools Control

- it executes through the Figma Plugin API, not the browser DOM
- operations produce structured acknowledgments
- every loop can refresh the design snapshot
- it can grow into a true node-level control runtime
