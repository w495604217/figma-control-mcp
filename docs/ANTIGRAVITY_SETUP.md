# Antigravity Setup

## Purpose

This guide explains how to use `figma-control-mcp` as an external MCP server inside Antigravity.

The project already exposes a standard MCP `stdio` server through `dist/index.js`, so Antigravity does **not** need a custom wrapper extension to use it.

## Integration Model

`figma-control-mcp` starts two layers at the same time:

1. a local HTTP bridge for plugin, desktop, and CLI workflows
2. a standard MCP `stdio` server for agent clients such as Antigravity

That means Antigravity only needs to launch:

```bash
node /absolute/path/to/figma-control-mcp/dist/index.js
```

## Prerequisites

Before connecting Antigravity, make sure all of the following are true:

1. Figma Desktop is installed
2. the `talk-to-figma` relay is available at `ws://127.0.0.1:3055`
3. the development plugin has been built:

```bash
npm install
npm run build
npm run build:plugin
```

4. macOS accessibility permissions are granted for the desktop automation path
5. the repository path is stable on disk

## Recommended Launch Strategy

Use the provided helper script:

```bash
/absolute/path/to/figma-control-mcp/scripts/run-antigravity-mcp.sh
```

This script:

- ensures `dist/index.js` exists
- uses stable defaults for the bridge state path
- starts the MCP server on `stdio`
- starts the local bridge on the configured port

## Example Antigravity MCP Entry

If Antigravity asks for a `command`, `args`, and `env`, use the following values.

### Command

```text
/absolute/path/to/figma-control-mcp/scripts/run-antigravity-mcp.sh
```

### Args

```json
[]
```

### Environment

```json
{
  "FIGMA_CONTROL_BRIDGE_PORT": "3847",
  "FIGMA_CONTROL_BRIDGE_TOKEN": "",
  "FIGMA_CONTROL_MCP_STATE_PATH": "/absolute/path/to/figma-control-mcp/.figma-control-mcp/bridge-state.json"
}
```

## TOML Example

See:

- [`examples/antigravity-mcp.config.toml`](/Users/wuchaodong/Desktop/工作流/首席宣传官/figma-control-mcp/examples/antigravity-mcp.config.toml)

This file is useful when your Antigravity setup accepts a TOML-based MCP server definition similar to Codex.

## Recommended Paths

Assuming the repository lives at:

```text
/Users/wuchaodong/Desktop/工作流/首席宣传官/figma-control-mcp
```

Recommended values are:

```text
command=/Users/wuchaodong/Desktop/工作流/首席宣传官/figma-control-mcp/scripts/run-antigravity-mcp.sh
FIGMA_CONTROL_MCP_STATE_PATH=/Users/wuchaodong/Desktop/工作流/首席宣传官/figma-control-mcp/.figma-control-mcp/bridge-state.json
FIGMA_CONTROL_BRIDGE_PORT=3847
```

## First-Run Checklist

Once Antigravity is configured:

1. start Figma Desktop
2. open a non-production Figma file
3. launch the development plugin or `talk-to-figma` workflow
4. confirm the bridge is healthy:

```bash
curl -s http://127.0.0.1:3847/healthz | jq
```

5. confirm Antigravity can call the MCP tool surface
6. run the live validation guide:

- [`docs/LIVE_VALIDATION.md`](/Users/wuchaodong/Desktop/工作流/首席宣传官/figma-control-mcp/docs/LIVE_VALIDATION.md)

## Operational Notes

### Why no Antigravity extension yet?

At this stage, the MCP server is already fully usable as an external process. A native Antigravity extension would mainly add:

- one-click installation
- richer environment checks
- GUI status for relay/plugin/bridge state
- simpler upgrades

Those are productization improvements, not prerequisites for daily use.

### Bridge persistence

The bridge state defaults to:

```text
.figma-control-mcp/bridge-state.json
```

This is where sessions, snapshots, queued operations, and related state are persisted.

### Trace persistence

Traces are persisted separately so they do not bloat the bridge state file:

```text
.figma-control-mcp/traces.json
```

## Troubleshooting

### Antigravity cannot start the MCP server

Check:

1. `npm run build` has completed
2. the script path is correct
3. the script is executable
4. `node` is available in the launch environment

### The MCP server starts, but materialization fails

This usually means the runtime is healthy but the Figma desktop fallback path is blocked by:

- missing Accessibility permission
- Figma not frontmost
- plugin overlays covering the Assets panel

Use:

- [`docs/LIVE_VALIDATION.md`](/Users/wuchaodong/Desktop/工作流/首席宣传官/figma-control-mcp/docs/LIVE_VALIDATION.md)
- [`docs/TRACE_DEBUGGING.md`](/Users/wuchaodong/Desktop/工作流/首席宣传官/figma-control-mcp/docs/TRACE_DEBUGGING.md)

### Antigravity needs a config example

Use:

- [`examples/antigravity-mcp.config.toml`](/Users/wuchaodong/Desktop/工作流/首席宣传官/figma-control-mcp/examples/antigravity-mcp.config.toml)

