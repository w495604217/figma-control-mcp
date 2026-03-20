import type { FigmaOperationInput } from "./schemas.js";
import { TalkToFigmaClient } from "./talk-to-figma.js";
import type { ExecutorAdapter, ExecutorResult } from "./operation-executor.js";

type JsonRecord = Record<string, unknown>;

type CreateNodeInput = Extract<FigmaOperationInput, { type: "create_node" }>;
type CreateInstanceInput = Extract<FigmaOperationInput, { type: "create_instance" }>;
type UpdateNodeInput = Extract<FigmaOperationInput, { type: "update_node" }>;
type DeleteNodeInput = Extract<FigmaOperationInput, { type: "delete_node" }>;
type MoveNodeInput = Extract<FigmaOperationInput, { type: "move_node" }>;
type SetSelectionInput = Extract<FigmaOperationInput, { type: "set_selection" }>;
type SetVariableInput = Extract<FigmaOperationInput, { type: "set_variable" }>;
type RunPluginActionInput = Extract<FigmaOperationInput, { type: "run_plugin_action" }>;

type TalkToFigmaExecutor = Pick<TalkToFigmaClient, "executeCommand">;

type TalkToFigmaAdapterOptions = {
  channel: string;
  wsUrl?: string;
  timeoutMs?: number;
  client?: TalkToFigmaExecutor;
};

const TALK_TO_FIGMA_OPERATION_CODE = `
const input = __FIGMA_CONTROL_INPUT__;

function isParentNode(node) {
  return Boolean(node && typeof node.appendChild === "function");
}

function isSceneNode(node) {
  return Boolean(node && typeof node.visible === "boolean");
}

function isGeometryMixin(node) {
  return Boolean(node && "fills" in node && "strokes" in node);
}

function isCornerMixin(node) {
  return Boolean(node && "cornerRadius" in node);
}

function isLayoutMixin(node) {
  return Boolean(node && "layoutMode" in node);
}

function isTextNode(node) {
  return Boolean(node && node.type === "TEXT");
}

function isResizable(node) {
  return Boolean(node && typeof node.resize === "function");
}

async function getNode(nodeId) {
  return await figma.getNodeByIdAsync(nodeId);
}

async function assertSceneNode(nodeId) {
  const node = await getNode(nodeId);
  if (!isSceneNode(node)) {
    throw new Error("Node " + nodeId + " was not found or is not a SceneNode");
  }
  return node;
}

async function getContainerNode(parentId, fallback) {
  const parent = parentId ? await getNode(parentId) : fallback;
  if (!isParentNode(parent)) {
    throw new Error("Parent " + (parentId || fallback.id) + " was not found or cannot contain children");
  }
  return parent;
}

async function insertIntoParent(node, parentId, index) {
  const parent = await getContainerNode(parentId, figma.currentPage);
  parent.appendChild(node);
  if (typeof index === "number" && typeof parent.insertChild === "function") {
    parent.insertChild(Math.min(index, parent.children.length - 1), node);
  }
}

async function reparentNode(node, parentId, index) {
  if (parentId === undefined && index === undefined) {
    return;
  }
  const fallbackParent = isParentNode(node.parent) ? node.parent : figma.currentPage;
  const parent = await getContainerNode(parentId, fallbackParent);
  parent.appendChild(node);
  if (typeof index === "number" && typeof parent.insertChild === "function") {
    parent.insertChild(Math.min(index, parent.children.length - 1), node);
  }
}

async function assertComponentNode(componentId) {
  const node = await getNode(componentId);
  if (!node || node.type !== "COMPONENT") {
    throw new Error("Component " + componentId + " was not found or is not a ComponentNode");
  }
  return node;
}

async function ensureFontLoaded(node, patch) {
  if (patch.fontName) {
    await figma.loadFontAsync(patch.fontName);
    return;
  }
  if (patch.characters !== undefined || patch.fontSize !== undefined) {
    if (node.fontName === figma.mixed) {
      throw new Error("Cannot update text with mixed fonts unless patch.fontName is provided");
    }
    await figma.loadFontAsync(node.fontName);
  }
}

function applyResize(node, patch) {
  if (!isResizable(node)) {
    return;
  }
  const hasWidth = typeof patch.width === "number";
  const hasHeight = typeof patch.height === "number";
  if (!hasWidth && !hasHeight) {
    return;
  }
  const width = hasWidth ? patch.width : node.width;
  const height = hasHeight ? patch.height : node.height;
  node.resize(width, height);
}

function applySharedProperties(node, patch) {
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
  if (typeof patch.rotation === "number" && "rotation" in node) {
    node.rotation = patch.rotation;
  }
  if (typeof patch.opacity === "number" && "opacity" in node) {
    node.opacity = patch.opacity;
  }
  applyResize(node, patch);
  if (isGeometryMixin(node) && Array.isArray(patch.fills)) {
    node.fills = patch.fills;
  }
  if (isGeometryMixin(node) && Array.isArray(patch.strokes)) {
    node.strokes = patch.strokes;
  }
  if (isCornerMixin(node) && typeof patch.cornerRadius === "number") {
    node.cornerRadius = patch.cornerRadius;
  }
  if (isLayoutMixin(node) && typeof patch.layoutMode === "string") {
    node.layoutMode = patch.layoutMode;
  }
  if (isLayoutMixin(node) && typeof patch.itemSpacing === "number") {
    node.itemSpacing = patch.itemSpacing;
  }
  if (isLayoutMixin(node) && typeof patch.paddingTop === "number") {
    node.paddingTop = patch.paddingTop;
  }
  if (isLayoutMixin(node) && typeof patch.paddingRight === "number") {
    node.paddingRight = patch.paddingRight;
  }
  if (isLayoutMixin(node) && typeof patch.paddingBottom === "number") {
    node.paddingBottom = patch.paddingBottom;
  }
  if (isLayoutMixin(node) && typeof patch.paddingLeft === "number") {
    node.paddingLeft = patch.paddingLeft;
  }
}

function createNodeFromSpec(spec) {
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
    case "COMPONENT":
      return figma.createComponent();
    case "SECTION":
      return figma.createSection();
    default:
      throw new Error("Unsupported create_node type: " + String(spec.type));
  }
}

async function createNode(input) {
  const node = createNodeFromSpec(input.node);
  await insertIntoParent(node, input.parentId, input.index);
  applySharedProperties(node, input.node);

  if (input.position) {
    node.x = input.position.x;
    node.y = input.position.y;
    applyResize(node, input.position);
  }

  if (isTextNode(node)) {
    const textPatch = input.node || {};
    await ensureFontLoaded(node, textPatch);
    if (typeof textPatch.characters === "string") {
      node.characters = textPatch.characters;
    }
    if (textPatch.fontName) {
      node.fontName = textPatch.fontName;
    }
    if (typeof textPatch.fontSize === "number") {
      node.fontSize = textPatch.fontSize;
    }
  }

  return {
    touchedNodeIds: [node.id],
    result: {
      createdNodeId: node.id
    }
  };
}

async function createInstance(input) {
  const component = input.componentId
    ? await assertComponentNode(input.componentId)
    : await figma.importComponentByKeyAsync(input.componentKey);

  const instance = component.createInstance();
  await insertIntoParent(instance, input.parentId, input.index);

  if (input.position) {
    instance.x = input.position.x;
    instance.y = input.position.y;
    applyResize(instance, input.position);
  }

  return {
    touchedNodeIds: [instance.id],
    result: {
      createdNodeId: instance.id,
      sourceComponentId: component.id,
      sourceComponentKey: component.key || input.componentKey
    }
  };
}

async function updateNode(input) {
  const node = await assertSceneNode(input.nodeId);
  applySharedProperties(node, input.patch);

  if (isTextNode(node)) {
    const textPatch = input.patch || {};
    await ensureFontLoaded(node, textPatch);
    if (typeof textPatch.characters === "string") {
      node.characters = textPatch.characters;
    }
    if (textPatch.fontName) {
      node.fontName = textPatch.fontName;
    }
    if (typeof textPatch.fontSize === "number") {
      node.fontSize = textPatch.fontSize;
    }
  }

  return {
    touchedNodeIds: [node.id],
    result: {
      updatedNodeId: node.id
    }
  };
}

async function deleteNode(input) {
  const node = await assertSceneNode(input.nodeId);
  node.remove();
  return {
    touchedNodeIds: [input.nodeId],
    result: {
      deletedNodeId: input.nodeId
    }
  };
}

async function moveNode(input) {
  const node = await assertSceneNode(input.nodeId);
  await reparentNode(node, input.parentId, input.index);
  if (input.position) {
    if (typeof input.position.x === "number") {
      node.x = input.position.x;
    }
    if (typeof input.position.y === "number") {
      node.y = input.position.y;
    }
    applyResize(node, input.position);
  }
  return {
    touchedNodeIds: [node.id],
    result: {
      movedNodeId: node.id
    }
  };
}

async function setSelection(input) {
  const selection = [];
  for (const nodeId of input.selectionIds || []) {
    const node = await getNode(nodeId);
    if (isSceneNode(node)) {
      selection.push(node);
    }
  }
  figma.currentPage.selection = selection;
  if (selection.length > 0) {
    figma.viewport.scrollAndZoomIntoView(selection);
  }
  return {
    touchedNodeIds: selection.map((node) => node.id),
    result: {
      selectionCount: selection.length
    }
  };
}

async function setVariable(input) {
  if (!figma.variables || typeof figma.variables.getVariableByIdAsync !== "function") {
    throw new Error("Variables API is unavailable in this Figma environment");
  }

  const variable = await figma.variables.getVariableByIdAsync(input.variableId);
  if (!variable) {
    throw new Error("Variable " + input.variableId + " was not found");
  }

  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const collection = collections.find((item) => item.id === variable.variableCollectionId);
  const modeId = collection && collection.defaultModeId;
  if (!modeId) {
    throw new Error("Variable collection for " + input.variableId + " has no default mode");
  }

  variable.setValueForMode(modeId, input.value);
  return {
    touchedNodeIds: [],
    result: {
      variableId: variable.id
    }
  };
}

async function runPluginAction(input) {
  switch (input.action) {
    case "scroll_into_view": {
      const targetId = input.payload && typeof input.payload.nodeId === "string" ? input.payload.nodeId : undefined;
      if (!targetId) {
        throw new Error("run_plugin_action.scroll_into_view requires payload.nodeId");
      }
      const node = await assertSceneNode(targetId);
      figma.viewport.scrollAndZoomIntoView([node]);
      return {
        touchedNodeIds: [node.id],
        result: {
          focusedNodeId: node.id
        }
      };
    }
    default:
      throw new Error("Unsupported plugin action: " + input.action);
  }
}

return await (async () => {
  switch (input.type) {
    case "create_node":
      return await createNode(input);
    case "create_instance":
      return await createInstance(input);
    case "update_node":
      return await updateNode(input);
    case "delete_node":
      return await deleteNode(input);
    case "move_node":
      return await moveNode(input);
    case "set_selection":
      return await setSelection(input);
    case "set_variable":
      return await setVariable(input);
    case "run_plugin_action":
      return await runPluginAction(input);
    default:
      throw new Error("Unsupported operation type: " + input.type);
  }
})();
`.trim();

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function buildOperationCode(operation: FigmaOperationInput): string {
  return TALK_TO_FIGMA_OPERATION_CODE.replace("__FIGMA_CONTROL_INPUT__", JSON.stringify(operation));
}

function unwrapExecuteCodeResult(value: unknown): ExecutorResult {
  const outer = asRecord(value);
  if (outer && outer.success === false) {
    throw new Error(typeof outer.error === "string" ? outer.error : "execute_code failed");
  }

  const payload = outer && "result" in outer ? outer.result : value;
  const record = asRecord(payload);
  if (!record) {
    return {
      touchedNodeIds: []
    };
  }

  return {
    touchedNodeIds: asStringArray(record.touchedNodeIds),
    result: asRecord(record.result) ?? undefined
  };
}

export class TalkToFigmaAdapter implements ExecutorAdapter {
  private readonly client: TalkToFigmaExecutor;
  private readonly channel: string;
  private readonly wsUrl?: string;
  private readonly timeoutMs: number;

  constructor(options: TalkToFigmaAdapterOptions) {
    this.client = options.client ?? new TalkToFigmaClient({ wsUrl: options.wsUrl });
    this.channel = options.channel;
    this.wsUrl = options.wsUrl;
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  private async executeOperation(operation: FigmaOperationInput): Promise<ExecutorResult> {
    const response = await this.client.executeCommand({
      channel: this.channel,
      command: "execute_code",
      params: {
        code: buildOperationCode(operation)
      },
      wsUrl: this.wsUrl,
      timeoutMs: this.timeoutMs
    });
    return unwrapExecuteCodeResult(response.result);
  }

  async createNode(input: CreateNodeInput): Promise<ExecutorResult> {
    return this.executeOperation(input);
  }

  async createInstance(input: CreateInstanceInput): Promise<ExecutorResult> {
    return this.executeOperation(input);
  }

  async updateNode(input: UpdateNodeInput): Promise<ExecutorResult> {
    return this.executeOperation(input);
  }

  async deleteNode(input: DeleteNodeInput): Promise<ExecutorResult> {
    return this.executeOperation(input);
  }

  async moveNode(input: MoveNodeInput): Promise<ExecutorResult> {
    return this.executeOperation(input);
  }

  async setSelection(input: SetSelectionInput): Promise<ExecutorResult> {
    return this.executeOperation(input);
  }

  async setVariable(input: SetVariableInput): Promise<ExecutorResult> {
    return this.executeOperation(input);
  }

  async runPluginAction(input: RunPluginActionInput): Promise<ExecutorResult> {
    return this.executeOperation(input);
  }
}
