# Live Validation Guide

## Purpose

This guide provides a repeatable procedure for validating Figma Control MCP against a live Figma file before a stable release.

It supplements the automated test suite (`npm test`) with runtime verification that exercises the actual Figma plugin, websocket relay, and desktop fallback surfaces.

## When to Use

- Before promoting a beta to a stable release
- After any change to session management, queue execution, or materialization
- When validating a new Figma Desktop or plugin version

## Prerequisites

1. Figma Desktop running on macOS
2. A test Figma file open (not a production file)
3. The `talk-to-figma` relay installed and running (`ws://127.0.0.1:3055`)
4. The development plugin built and available in Figma

```bash
npm run build:plugin
```

## Validation Procedure

### Step 1: Start the bridge

```bash
npm run dev
```

Verify health:

```bash
curl -s http://127.0.0.1:3847/healthz | jq
# Expected: { "ok": true, ... }
```

### Step 2: Verify session ensuring

```bash
curl -s -X POST http://127.0.0.1:3847/bridge/talk-to-figma/ensure-session \
  -H 'content-type: application/json' \
  -d '{}' | jq '.strategy, .sessionHealth, .session.sessionId'
```

Expected:
- `strategy`: one of `existing-session`, `discover`, `launch`
- `sessionHealth`: `active`
- A valid `sessionId`

Check the trace was recorded:

```bash
curl -s 'http://127.0.0.1:3847/bridge/traces?flowType=ensure-session&limit=1' | jq '.traces[0].status'
# Expected: "succeeded"
```

### Step 3: Verify snapshot synchronization

```bash
curl -s http://127.0.0.1:3847/bridge/status | jq '.sessions[0].sessionId'
```

Expected: a valid session ID with a synced snapshot.

### Step 4: Verify queue execution

Enqueue a simple operation:

```bash
curl -s -X POST http://127.0.0.1:3847/bridge/enqueue-batch \
  -H 'content-type: application/json' \
  -d '{
    "sessionId": "<sessionId>",
    "operations": [{
      "type": "create_node",
      "node": { "type": "FRAME", "name": "ValidationTestFrame" },
      "position": { "x": 0, "y": 0, "width": 200, "height": 100 }
    }]
  }' | jq '.operationIds'
```

Run the queue:

```bash
curl -s -X POST http://127.0.0.1:3847/bridge/talk-to-figma/run-queue \
  -H 'content-type: application/json' \
  -d '{"sessionId": "<sessionId>"}' | jq '.batches[0].status, .processedCount'
```

Expected:
- `status`: `succeeded`
- `processedCount`: `1`

Verify the frame appeared in Figma.

Check the queue trace:

```bash
curl -s 'http://127.0.0.1:3847/bridge/traces?flowType=queue-execution&limit=1' | jq '.traces[0].status'
# Expected: "succeeded"
```

### Step 5: Verify component search

```bash
curl -s 'http://127.0.0.1:3847/bridge/components?query=Button' | jq '.count'
```

Expected: at least `0` (depends on whether a kit is loaded).

### Step 6: Verify instance overrides (optional)

If a component library is loaded:

```bash
curl -s -X POST http://127.0.0.1:3847/bridge/enqueue-batch \
  -H 'content-type: application/json' \
  -d '{
    "sessionId": "<sessionId>",
    "operations": [{
      "type": "create_instance",
      "componentKey": "<publishedKey>",
      "variantProperties": { "Size": "Large" },
      "textOverrides": { "Label": "Validation Test" }
    }]
  }' | jq '.operationIds'
```

Then run the queue and inspect the result's `overrideResults`.

### Step 7: Verify trace tree

```bash
# Get the most recent materialize or ensure trace
TRACE_ID=$(curl -s 'http://127.0.0.1:3847/bridge/traces?limit=1' | jq -r '.traces[0].traceId')

# Retrieve the tree
curl -s "http://127.0.0.1:3847/bridge/traces/${TRACE_ID}/tree" | jq '.count, [.tree[].flowType]'
```

### Step 8: Cleanup

Delete the test frame from Figma.

## Validation Record

After completing the procedure, record:

| Item | Value |
|------|-------|
| Figma Desktop version | _fill in_ |
| macOS version | _fill in_ |
| Node.js version | _fill in_ |
| Bridge version | _fill in_ |
| Plugin version | _fill in_ |
| Steps completed | 1–7 or 1–8 |
| Failures encountered | _none / describe_ |
| Traces inspected | _yes / no_ |

## Offline-Only Validation

If live Figma is not available, the following commands provide offline validation:

```bash
npm test
npm run build
npm run typecheck:plugin
npm run build:plugin
```

All of these are required to pass for any release candidate.

## Known Limitations in Live Validation

- Component search depends on which libraries are loaded in the test file
- Instance overrides require a component with known variant properties
- Desktop fallback validation requires Figma to be focused and visible
- Trace tree depth depends on which flow was exercised
