# Plugin Bridge Contract

This document defines how a Figma plugin should integrate with `figma-control-mcp`.

The goal is not to let an agent control the Figma website directly. The goal is to let an agent send structured instructions through MCP and have a plugin execute them inside the native Figma runtime.

## Recommended Directory Layout

```text
figma-plugin/
  manifest.json
  src/
    code.ts
    ui.ts
    bridge/
      client.ts
      snapshot.ts
      executor.ts
      operations.ts
```

## Recommended Stack

- Plugin: TypeScript
- Bundler: Vite or tsup
- Runtime bridge: Figma Plugin API + UI iframe `fetch`
- Schema validation: Zod

## Required Plugin Responsibilities

### 1. Register a session

When the plugin starts, it should immediately register with the local HTTP bridge:

```json
{
  "sessionId": "figma-<fileKey>-<pageId>",
  "fileKey": "<figma file key>",
  "fileName": "<current file name>",
  "pageId": "<current page id>",
  "pageName": "<current page name>",
  "selectionIds": ["..."],
  "pluginVersion": "0.0.1-beta",
  "bridgeVersion": "0.0.1-beta"
}
```

### 2. Publish a snapshot

At minimum, a snapshot should include:

- current file and page information
- current selection
- current page node list
- variable list

Do not start by returning full geometry for the entire document. Prefer a lightweight snapshot first:

- `id`
- `name`
- `type`
- `parentId`
- `childIds`
- `visible`
- `locked`
- `bounds`

## Operation Execution Loop

The plugin should usually maintain a stable polling loop:

1. `POST /bridge/register-session`
2. `POST /bridge/snapshot`
3. `POST /bridge/pull-operations`
4. execute operations
5. `POST /bridge/acknowledge`
6. if the document structure changed, `POST /bridge/snapshot` again

## Mapping MCP Operations to the Figma API

### `create_node`

The plugin side should map `node.type` to the correct Figma factory call, for example:

- `FRAME` -> `figma.createFrame()`
- `TEXT` -> `figma.createText()`
- `RECTANGLE` -> `figma.createRectangle()`
- `ELLIPSE` -> `figma.createEllipse()`
- `COMPONENT` -> `figma.createComponent()`

Then:

1. apply base properties
2. insert into `parentId`
3. adjust sibling order according to `index`
4. if `position` is present, apply `x/y/resize`

### `update_node`

Prefer a patch whitelist instead of unrestricted object merging:

- `name`
- `visible`
- `locked`
- `x`
- `y`
- `width`
- `height`
- `fills`
- `strokes`
- `cornerRadius`
- `layoutMode`
- `padding*`
- `itemSpacing`
- `characters`
- `fontName`
- `fontSize`

Do not apply unbounded deep merges to runtime nodes.

### `delete_node`

You can call `node.remove()` directly, but first guard against:

- missing nodes
- nodes that should not be deleted
- current page or document root nodes

### `move_node`

Recommended flow:

1. resolve the target node
2. resolve the target parent
3. call `appendChild` or insert at the requested index
4. if `position` is provided, then apply coordinates

### `set_variable`

For the first iteration, only support already-existing variable ids. Do not auto-create collections yet.

### `set_selection`

Update `figma.currentPage.selection` directly.

## Plugin Execution Result Format

Each operation should return something like:

```json
{
  "operationId": "uuid",
  "status": "succeeded",
  "touchedNodeIds": ["12:34"],
  "result": {
    "createdNodeId": "12:34"
  }
}
```

On failure, return something like:

```json
{
  "operationId": "uuid",
  "status": "failed",
  "error": "Node 12:34 not found"
}
```

## What Not To Do In The First Phase

Avoid these early on, or complexity will grow too quickly:

- direct DOM automation against the Figma website
- putting all plugin behavior into one giant tool
- automatic inference for arbitrary node paths
- full support for every Figma node type on day one
- automatic local font mapping
- automatic creation of complex variable collections or modes

## Minimum Useful Milestones

### M1

- session registration
- lightweight page snapshots
- `create_node`
- `update_node`
- `delete_node`
- `set_selection`

### M2

- `move_node`
- `set_variable`
- selection and path resolver
- aggregated batch execution results

### M3

- dry-run
- structural diffing
- retry and rollback strategy
- broader layout and style patch coverage

## When It Starts To Feel Close To Pencil MCP

It becomes meaningfully close only when all four of these are true:

1. the agent receives a structured page tree instead of a screenshot
2. operations are node-level rather than click-level
3. every operation returns clear success or failure with touched nodes
4. snapshots and operations can repeatedly close the loop
