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

直接走完整链路，把 Assets 结果落到画布并自动选中：

```bash
npm run bridge:materialize-asset -- Toolbar talk-to-figma:x2lmbp3m
```

如果不想手动提供 session，也可以直接调用 HTTP route，让它自动 discover：

```bash
curl -s -X POST http://127.0.0.1:3847/bridge/materialize-asset \
  -H 'content-type: application/json' \
  -d '{"query":"Toolbar","dryRun":true}'
```

说明：

- 这是桌面 OCR 扫描，不依赖 Figma Plugin API
- 适合回答“当前 Figma app 里我能看到哪些 kit”
- OCR 结果可能有轻微拼写误差，但已经足够做后续点击/检索的候选集

## 当前完成度

- 画布内静默控制：可用
- talk-to-figma channel 探测、discover、sync、queue 执行：可用
- Assets 面板库可见性扫描：可用
- Assets 搜索：可用
- 一键落图 `materialize_figma_asset`：可用
- 自动选中并同步插入结果：可用
- 当前最大的现实边界仍然是 Figma 官方没有开放“全量 library 枚举/启用”API，所以这部分仍需桌面层兜底

## 下一步应该补什么

要达到接近 Pencil MCP 的控制程度，下一步建议按这个顺序扩：

1. 扩展更多节点类型和 patch 白名单，减少“字段被忽略”的面积
2. 做 dry-run / capability probing，让 agent 先知道哪些修改在当前文档可执行
3. 增强路径解析的歧义提示和 selector 能力
4. 增加更稳定的 batch 恢复策略，不只依赖 undo
5. 加一层 “design AST diff” 输出，方便 agent 做增量操作

详细 plugin 接入契约见：

- `docs/plugin-bridge-contract.md`
- `plugin-example/README.md`
- `examples/update-hero-button.json`
- `examples/create-footer-cta.json`

## 一个最小 plugin bridge 工作流

1. Plugin 启动后调用 `register_figma_session`
2. Plugin 抓取当前页面节点图，调用 `publish_figma_snapshot`
3. Agent 调用 `enqueue_figma_operations`
4. Plugin 轮询 `pull_figma_operations`
5. Plugin 执行 Figma Plugin API
6. Plugin 调用 `acknowledge_figma_operations`
7. Plugin 再次调用 `publish_figma_snapshot`

## 跨 kit 导入工作流

1. 在 kit 文件标签页启动 worker，让它把整份 kit 的 published components 上传到 bridge
2. 用 `search_live_figma_components` 或 `npm run bridge:components` 找到目标组件的 `componentKey`
3. 在目标项目文件标签页，对目标 session enqueue 一个 `create_instance`
4. plugin 在目标文件里调用 `importComponentByKeyAsync` 并直接创建实例

## 为什么这条路更接近 Pencil

- 不是 OCR / 浏览器点击
- 画布内修改已经可以走 websocket 静默命令，不需要和用户争抢鼠标
- 结构化 enqueue/batch 现在也可以直接落到 talk-to-figma session，不必手写 raw websocket command
- 桌面自动化只保留给 library discovery / Assets 面板这种官方 API 没开放的区域
- 插件启动本身已经可以走 macOS 菜单自动化，不必再依赖 Quick Actions 搜索
- 不是网页 DOM 猜测
- 每个操作都有结构化结果
- 可做幂等、重试、回滚和 diff
- 可以逐步长成真正的“Figma AST 控制层”
