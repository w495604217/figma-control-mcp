# Plugin Bridge Contract

这份文档定义的是 “Figma Plugin 端应该怎么接入 `figma-control-mcp`”。

目标不是让 agent 直接控制 Figma 网页，而是让 agent 通过 MCP 下发结构化指令，由 plugin 在 Figma 原生运行时执行。

## 推荐目录

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

## 推荐技术栈

- Plugin: TypeScript
- Bundler: Vite 或 tsup
- Runtime bridge: Figma Plugin API + UI iframe `fetch`
- Schema validation: Zod

## Plugin 端必须做的事

### 1. 注册 session

Plugin 启动后立即向本地 HTTP bridge 注册：

```json
{
  "sessionId": "figma-<fileKey>-<pageId>",
  "fileKey": "<figma file key>",
  "fileName": "<current file name>",
  "pageId": "<current page id>",
  "pageName": "<current page name>",
  "selectionIds": ["..."],
  "pluginVersion": "0.1.0",
  "bridgeVersion": "0.1.0"
}
```

### 2. 发布快照

最小快照至少应包含：

- 当前文件和页面信息
- 当前 selection
- 当前页面节点列表
- 变量列表

建议不要一上来把全文件所有 geometry 全量回传，先做“轻快照”：

- `id`
- `name`
- `type`
- `parentId`
- `childIds`
- `visible`
- `locked`
- `bounds`

## 操作执行循环

Plugin 建议维护一个固定轮询循环：

1. `POST /bridge/register-session`
2. `POST /bridge/snapshot`
3. `POST /bridge/pull-operations`
4. 执行操作
5. `POST /bridge/acknowledge`
6. 如果有结构变化，再次 `POST /bridge/snapshot`

## MCP 操作到 Figma API 的映射

### `create_node`

Plugin 侧需要根据 `node.type` 做工厂映射，例如：

- `FRAME` -> `figma.createFrame()`
- `TEXT` -> `figma.createText()`
- `RECTANGLE` -> `figma.createRectangle()`
- `ELLIPSE` -> `figma.createEllipse()`
- `COMPONENT` -> `figma.createComponent()`

然后：

1. 应用基础属性
2. 插入到 `parentId`
3. 按 `index` 调整 sibling 顺序
4. 如有 `position`，设置 `x/y/resize`

### `update_node`

推荐只允许 patch 白名单属性：

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

不要直接做无限制对象合并。

### `delete_node`

直接调用 `node.remove()`，但要先防守：

- 节点是否存在
- 节点是否允许删除
- 是否为当前 page / document 根节点

### `move_node`

推荐流程：

1. 找到目标 node
2. 找到目标 parent
3. 调用 `appendChild` 或者插入到指定 index
4. 如传了 `position`，再设置坐标

### `set_variable`

第一版建议只支持已经存在的 variable id，先不做 collection 自动创建。

### `set_selection`

直接更新 `figma.currentPage.selection`

## 插件执行结果格式

每个 operation 执行后返回：

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

失败则返回：

```json
{
  "operationId": "uuid",
  "status": "failed",
  "error": "Node 12:34 not found"
}
```

## 第一阶段不要做的事

先不要做这些，否则复杂度会快速失控：

- 直接对 Figma 网页做 DOM 自动化
- 把所有 plugin 行为都塞进一个超大 tool
- 自动推断任意节点路径
- 一次性支持所有 Figma node 类型
- 自动创建本地字体映射
- 自动创建复杂 variable collection / mode

## 最小可用里程碑

### M1

- session 注册
- 页面轻快照
- `create_node`
- `update_node`
- `delete_node`
- `set_selection`

### M2

- `move_node`
- `set_variable`
- selection/path resolver
- 批量执行结果汇总

### M3

- dry-run
- 差异对比
- 重试/回滚策略
- 更完整的 layout/style patch

## 什么时候它才算接近 Pencil MCP

当下面四件事都具备时，才算真的接近：

1. Agent 拿到的是结构化页面树，不是网页截图
2. 操作是节点级的，不是鼠标点击级的
3. 每个操作有明确成功/失败和 touched nodes
4. 快照和操作可以反复闭环
