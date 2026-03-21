const SESSION_PLUGIN_DATA_KEY = "figma-control-mcp-session-id";
const BRIDGE_BASE_URL = "http://127.0.0.1:3847";
const PLUGIN_VERSION = "0.1.1";
const BRIDGE_VERSION = "0.1.1";
const POLL_INTERVAL_MS = 1500;
const UI_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Figma Control MCP Worker</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      }
      body {
        margin: 0;
        background: #111827;
        color: #e5e7eb;
      }
      header {
        padding: 10px 12px;
        border-bottom: 1px solid #1f2937;
        font-size: 12px;
        color: #93c5fd;
      }
      #log {
        box-sizing: border-box;
        height: 280px;
        overflow: auto;
        margin: 0;
        padding: 12px;
        white-space: pre-wrap;
        line-height: 1.45;
        font-size: 12px;
      }
    </style>
  </head>
  <body>
    <header>Figma Control MCP Worker Debug</header>
    <pre id="log">waiting for plugin startup...</pre>
    <script>
      const logEl = document.getElementById("log");

      function appendLine(line) {
        logEl.textContent += "\\n" + line;
        logEl.scrollTop = logEl.scrollHeight;
      }

      async function postJson(baseUrl, path, payload) {
        const response = await fetch(baseUrl + path, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(payload)
        });
        const json = await response.json();
        if (!response.ok) {
          throw new Error(json && json.error ? String(json.error) : "HTTP " + response.status);
        }
        return json;
      }

      async function runBoot(payload) {
        appendLine("ui:register-session");
        await postJson(payload.bridgeBaseUrl, "/bridge/register-session", payload.session);

        appendLine("ui:publish-snapshot");
        await postJson(payload.bridgeBaseUrl, "/bridge/snapshot", payload.snapshot);

        appendLine("ui:boot-complete");
        parent.postMessage({
          pluginMessage: {
            type: "boot-result",
            ok: true
          }
        }, "*");

        if (payload.mode === "start-worker") {
          appendLine("ui:worker-started");
          await runWorkerLoop(payload.bridgeBaseUrl, payload.session.sessionId);
        }
      }

      function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }

      function createDeferred() {
        let resolve;
        let reject;
        const promise = new Promise((res, rej) => {
          resolve = res;
          reject = rej;
        });
        return { promise, resolve, reject };
      }

      const pendingExecutions = new Map();
      let requestCounter = 0;

      async function executeOperationsOnMain(operations, sessionId) {
        requestCounter += 1;
        const requestId = "exec-" + requestCounter;
        const deferred = createDeferred();
        pendingExecutions.set(requestId, deferred);
        parent.postMessage({
          pluginMessage: {
            type: "execute-operations",
            requestId,
            sessionId,
            operations
          }
        }, "*");
        return deferred.promise;
      }

      async function runWorkerLoop(baseUrl, sessionId) {
        while (true) {
          try {
            const pulled = await postJson(baseUrl, "/bridge/pull-operations", {
              sessionId,
              limit: 20
            });

            if (pulled.count > 0) {
              appendLine("ui:execute " + pulled.count);
              const execution = await executeOperationsOnMain(pulled.operations, sessionId);
              await postJson(baseUrl, "/bridge/acknowledge", {
                sessionId,
                updates: execution.updates
              });
              await postJson(baseUrl, "/bridge/snapshot", execution.snapshot);
              appendLine("ui:acknowledged " + execution.updates.length);
            }
          } catch (error) {
            const message = error instanceof Error ? (error.stack || error.message) : String(error);
            appendLine("ui:worker-error " + message);
          }

          await sleep(${POLL_INTERVAL_MS});
        }
      }

      window.onmessage = async (event) => {
        const pluginMessage = event.data && event.data.pluginMessage;
        if (!pluginMessage) {
          return;
        }

        if (pluginMessage.type === "log") {
          appendLine(pluginMessage.message);
          return;
        }

        if (pluginMessage.type === "execution-result") {
          const deferred = pendingExecutions.get(pluginMessage.requestId);
          if (!deferred) {
            appendLine("ui:missing-request " + pluginMessage.requestId);
            return;
          }
          pendingExecutions.delete(pluginMessage.requestId);
          deferred.resolve(pluginMessage);
          return;
        }

        if (pluginMessage.type !== "boot") {
          return;
        }

        try {
          await runBoot(pluginMessage);
        } catch (error) {
          const message = error instanceof Error ? (error.stack || error.message) : String(error);
          appendLine("ui:error " + message);
          parent.postMessage({
            pluginMessage: {
              type: "boot-result",
              ok: false,
              error: message
            }
          }, "*");
        }
      };

      appendLine("ui:ready");
      parent.postMessage({
        pluginMessage: {
          type: "ui-ready"
        }
      }, "*");
    </script>
  </body>
</html>`;

type JsonRecord = Record<string, unknown>;
type FigmaOperationRecord = {
  operationId: string;
  operation: {
    type: string;
    [key: string]: unknown;
  };
};

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}

function log(message: string, options: { error?: boolean } = {}): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  figma.ui.postMessage({
    type: "log",
    message: line
  });
  figma.notify(message, {
    error: options.error ?? false,
    timeout: 1400
  });
}

function ensureUi(visible = false): void {
  figma.showUI(UI_HTML, {
    visible,
    width: visible ? 460 : 70,
    height: visible ? 340 : 0
  });
}

function createSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `figma-${crypto.randomUUID()}`;
  }

  const random = Math.random().toString(36).slice(2, 10);
  return `figma-${Date.now().toString(36)}-${random}`;
}

function getOrCreateSessionId(): string {
  const existing = figma.root.getPluginData(SESSION_PLUGIN_DATA_KEY);
  if (existing) {
    return existing;
  }

  const sessionId = createSessionId();
  figma.root.setPluginData(SESSION_PLUGIN_DATA_KEY, sessionId);
  return sessionId;
}

function serializeNode(node: SceneNode): JsonRecord {
  const mainComponent = "mainComponent" in node && node.mainComponent ? node.mainComponent : undefined;

  return {
    id: node.id,
    name: node.name,
    type: node.type,
    parentId: "parent" in node && node.parent ? node.parent.id : undefined,
    childIds: "children" in node ? node.children.map((child) => child.id) : [],
    visible: "visible" in node ? node.visible : undefined,
    locked: "locked" in node ? node.locked : undefined,
    componentId: mainComponent?.id,
    componentKey: mainComponent?.key || undefined,
    componentName: mainComponent?.name
  };
}

function buildSession(sessionId: string): JsonRecord {
  return {
    sessionId,
    fileKey: figma.fileKey,
    fileName: figma.root.name,
    pageId: figma.currentPage.id,
    pageName: figma.currentPage.name,
    selectionIds: figma.currentPage.selection.map((node) => node.id),
    metadata: {},
    pluginVersion: PLUGIN_VERSION,
    bridgeVersion: BRIDGE_VERSION
  };
}

async function getPublishedComponents(): Promise<JsonRecord[]> {
  await figma.loadAllPagesAsync();

  return figma.root.children.flatMap((page) =>
    page.findAllWithCriteria({ types: ["COMPONENT"] }).map((node) => ({
      id: node.id,
      key: node.key || undefined,
      name: node.name,
      nodeId: node.id,
      pageId: page.id,
      pageName: page.name,
      description: node.description || undefined,
      componentSetId: node.parent?.type === "COMPONENT_SET" ? node.parent.id : undefined
    }))
  );
}

function getInstanceBackedComponents(nodes: SceneNode[]): JsonRecord[] {
  const seen = new Set<string>();
  const output: JsonRecord[] = [];

  for (const node of nodes) {
    if (node.type !== "INSTANCE" || !node.mainComponent || !node.mainComponent.key) {
      continue;
    }

    if (seen.has(node.mainComponent.key)) {
      continue;
    }
    seen.add(node.mainComponent.key);

    output.push({
      id: node.mainComponent.id,
      key: node.mainComponent.key,
      name: node.mainComponent.name,
      nodeId: node.id,
      pageId: figma.currentPage.id,
      pageName: figma.currentPage.name,
      description: node.mainComponent.description || undefined,
      componentSetId: node.mainComponent.parent?.type === "COMPONENT_SET" ? node.mainComponent.parent.id : undefined
    });
  }

  return output;
}

async function buildSnapshot(sessionId: string): Promise<JsonRecord> {
  const nodes = figma.currentPage.findAll();
  const components = [...await getPublishedComponents(), ...getInstanceBackedComponents(nodes)];

  return {
    sessionId,
    fileKey: figma.fileKey,
    fileName: figma.root.name,
    pageId: figma.currentPage.id,
    pageName: figma.currentPage.name,
    selectionIds: figma.currentPage.selection.map((node) => node.id),
    nodes: nodes.map(serializeNode),
    variables: [],
    components,
    capturedAt: new Date().toISOString()
  };
}

function isParentNode(node: BaseNode | null): node is ChildrenMixin & BaseNode {
  return Boolean(node && "appendChild" in node);
}

function isSceneNode(node: BaseNode | null): node is SceneNode {
  return Boolean(node && "visible" in node);
}

function isTextNode(node: SceneNode): node is TextNode {
  return node.type === "TEXT";
}

function isResizable(node: SceneNode): node is SceneNode & LayoutMixin {
  return "resize" in node;
}

function isGeometryMixin(node: SceneNode): node is SceneNode & GeometryMixin {
  return "fills" in node && "strokes" in node;
}

function assertSceneNode(node: BaseNode | null, nodeId: string): SceneNode {
  if (!isSceneNode(node)) {
    throw new Error(`Node ${nodeId} was not found or is not a SceneNode`);
  }
  return node;
}

async function findNodeById(nodeId: string): Promise<BaseNode | null> {
  return await figma.getNodeByIdAsync(nodeId);
}

async function insertIntoParent(node: SceneNode, parentId?: string, index?: number): Promise<void> {
  const parent = parentId ? await findNodeById(parentId) : figma.currentPage;
  if (!isParentNode(parent)) {
    throw new Error(`Parent ${parentId ?? figma.currentPage.id} was not found or cannot contain children`);
  }

  parent.appendChild(node);
  if (typeof index === "number" && "insertChild" in parent) {
    parent.insertChild(Math.min(index, parent.children.length - 1), node);
  }
}

function createNodeFromSpec(spec: JsonRecord): SceneNode {
  const type = typeof spec.type === "string" ? spec.type.toUpperCase() : undefined;
  switch (type) {
    case "FRAME":
      return figma.createFrame();
    case "TEXT":
      return figma.createText();
    case "RECTANGLE":
      return figma.createRectangle();
    case "ELLIPSE":
      return figma.createEllipse();
    case "SECTION":
      return figma.createSection();
    default:
      throw new Error(`Unsupported create_node type: ${String(spec.type)}`);
  }
}

async function ensureTextFont(node: TextNode, patch: JsonRecord): Promise<void> {
  const fontName = patch.fontName;
  if (fontName && typeof fontName === "object") {
    await figma.loadFontAsync(fontName as FontName);
    return;
  }
  if (patch.characters !== undefined || patch.fontSize !== undefined) {
    if (node.fontName === figma.mixed) {
      throw new Error("Cannot update text with mixed fonts unless patch.fontName is provided");
    }
    await figma.loadFontAsync(node.fontName);
  }
}

async function applyPatch(node: SceneNode, patch: JsonRecord): Promise<void> {
  if (typeof patch.name === "string") {
    node.name = patch.name;
  }
  if (typeof patch.visible === "boolean") {
    node.visible = patch.visible;
  }
  if (typeof patch.locked === "boolean") {
    node.locked = patch.locked;
  }
  if (typeof patch.x === "number") {
    node.x = patch.x;
  }
  if (typeof patch.y === "number") {
    node.y = patch.y;
  }
  if (isResizable(node) && typeof patch.width === "number" && typeof patch.height === "number") {
    node.resize(patch.width, patch.height);
  }
  if (isGeometryMixin(node) && Array.isArray(patch.fills)) {
    node.fills = patch.fills as Paint[];
  }
  if (isGeometryMixin(node) && Array.isArray(patch.strokes)) {
    node.strokes = patch.strokes as Paint[];
  }

  if (isTextNode(node)) {
    await ensureTextFont(node, patch);
    if (typeof patch.characters === "string") {
      node.characters = patch.characters;
    }
    if (patch.fontName && typeof patch.fontName === "object") {
      node.fontName = patch.fontName as FontName;
    }
    if (typeof patch.fontSize === "number") {
      node.fontSize = patch.fontSize;
    }
  }
}

async function executeOperation(record: FigmaOperationRecord): Promise<JsonRecord> {
  const operation = record.operation;

  switch (operation.type) {
    case "create_node": {
      const node = createNodeFromSpec(operation.node as JsonRecord);
      await insertIntoParent(node, operation.parentId as string | undefined, operation.index as number | undefined);
      await applyPatch(node, operation.node as JsonRecord);
      return {
        operationId: record.operationId,
        status: "succeeded",
        touchedNodeIds: [node.id],
        result: {
          createdNodeId: node.id
        }
      };
    }
    case "create_instance": {
      const component = operation.componentId
        ? await findNodeById(operation.componentId as string)
        : await figma.importComponentByKeyAsync(operation.componentKey as string);
      if (!component || component.type !== "COMPONENT") {
        throw new Error("Source component was not found or is not a ComponentNode");
      }
      const instance = component.createInstance();
      await insertIntoParent(instance, operation.parentId as string | undefined, operation.index as number | undefined);

      const applied: string[] = [];
      const warnings: Array<{ property: string; reason: string }> = [];

      // Variant and component properties via setProperties()
      const propsToSet: Record<string, string | boolean> = {};
      const variantProps = operation.variantProperties as Record<string, string> | undefined;
      const componentProps = operation.componentProperties as Record<string, string | boolean> | undefined;

      if (variantProps) {
        for (const [key, value] of Object.entries(variantProps)) {
          propsToSet[key] = value;
        }
      }
      if (componentProps) {
        for (const [key, value] of Object.entries(componentProps)) {
          propsToSet[key] = value;
        }
      }

      for (const [propName, propValue] of Object.entries(propsToSet)) {
        try {
          instance.setProperties({ [propName]: propValue });
          applied.push(propName);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          warnings.push({ property: propName, reason: message });
        }
      }

      // Text overrides via child name walk
      const textOverrides = operation.textOverrides as Record<string, string> | undefined;
      if (textOverrides) {
        for (const [childName, newText] of Object.entries(textOverrides)) {
          try {
            const found = instance.findOne((n: SceneNode) => n.type === "TEXT" && n.name === childName) as TextNode | null;
            if (!found) {
              warnings.push({
                property: `textOverride:${childName}`,
                reason: `Text node with name '${childName}' was not found in instance`
              });
            } else {
              if (found.fontName === figma.mixed) {
                throw new Error("Cannot override text with mixed fonts");
              }
              await figma.loadFontAsync(found.fontName);
              found.characters = newText;
              applied.push(`textOverride:${childName}`);
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            warnings.push({ property: `textOverride:${childName}`, reason: message });
          }
        }
      }

      const instanceResult: JsonRecord = {
        createdNodeId: instance.id,
        sourceComponentId: component.id,
        sourceComponentKey: component.key || operation.componentKey
      };

      if (applied.length > 0 || warnings.length > 0) {
        instanceResult.overrideResults = { applied, warnings };
      }

      return {
        operationId: record.operationId,
        status: "succeeded",
        touchedNodeIds: [instance.id],
        result: instanceResult
      };
    }
    case "update_node": {
      const node = assertSceneNode(await findNodeById(operation.nodeId as string), operation.nodeId as string);
      await applyPatch(node, operation.patch as JsonRecord);
      return {
        operationId: record.operationId,
        status: "succeeded",
        touchedNodeIds: [node.id]
      };
    }
    case "delete_node": {
      const node = assertSceneNode(await findNodeById(operation.nodeId as string), operation.nodeId as string);
      node.remove();
      return {
        operationId: record.operationId,
        status: "succeeded",
        touchedNodeIds: [operation.nodeId as string]
      };
    }
    case "set_selection": {
      const ids = Array.isArray(operation.selectionIds) ? operation.selectionIds : [];
      const selection = (await Promise.all(ids.map((id) => findNodeById(id as string))))
        .filter((node): node is SceneNode => isSceneNode(node));
      figma.currentPage.selection = selection;
      return {
        operationId: record.operationId,
        status: "succeeded",
        touchedNodeIds: selection.map((node) => node.id)
      };
    }
    default:
      throw new Error(`Unsupported operation type: ${operation.type}`);
  }
}

async function executeOperations(records: FigmaOperationRecord[], sessionId: string): Promise<{
  updates: JsonRecord[];
  snapshot: JsonRecord;
}> {
  const updates: JsonRecord[] = [];
  for (const record of records) {
    try {
      updates.push(await executeOperation(record));
    } catch (error) {
      updates.push({
        operationId: record.operationId,
        status: "failed",
        error: stringifyError(error),
        touchedNodeIds: []
      });
    }
  }

  return {
    updates,
    snapshot: await buildSnapshot(sessionId)
  };
}

async function boot(): Promise<void> {
  ensureUi(figma.command === "sync-once");
  log(`plugin:start command=${figma.command ?? "start-worker"}`);
  figma.skipInvisibleInstanceChildren = true;
  log("plugin:skipInvisibleInstanceChildren=true");

  figma.ui.onmessage = async (message: {
    type?: string;
    ok?: boolean;
    error?: string;
  }) => {
    if (message.type === "ui-ready") {
      const sessionId = getOrCreateSessionId();
      log(`plugin:session=${sessionId}`);
      figma.ui.postMessage({
        type: "boot",
        bridgeBaseUrl: BRIDGE_BASE_URL,
        mode: figma.command ?? "start-worker",
        session: buildSession(sessionId),
        snapshot: await buildSnapshot(sessionId)
      });
      return;
    }

    if (message.type === "execute-operations") {
      const requestId = (message as JsonRecord).requestId as string;
      const sessionId = (message as JsonRecord).sessionId as string;
      const operations = ((message as JsonRecord).operations ?? []) as FigmaOperationRecord[];
      const execution = await executeOperations(operations, sessionId);
      figma.ui.postMessage({
        type: "execution-result",
        requestId,
        updates: execution.updates,
        snapshot: execution.snapshot
      });
      return;
    }

    if (message.type !== "boot-result") {
      return;
    }

    if (!message.ok) {
      log(`plugin:boot-failed ${message.error ?? "unknown error"}`, { error: true });
      return;
    }

    log("plugin:boot-complete");
    if (figma.command === "sync-once") {
      figma.closePlugin("Sync Once completed");
    }
  };
}

void boot().catch((error) => {
  ensureUi(true);
  log(`plugin:fatal ${stringifyError(error)}`, { error: true });
});
