import type { FigmaOperationInput } from "../../src/schemas.js";
import type { ExecutorAdapter, ExecutorResult } from "./executor.js";

type CreateNodeInput = Extract<FigmaOperationInput, { type: "create_node" }>;
type CreateInstanceInput = Extract<FigmaOperationInput, { type: "create_instance" }>;
type UpdateNodeInput = Extract<FigmaOperationInput, { type: "update_node" }>;
type DeleteNodeInput = Extract<FigmaOperationInput, { type: "delete_node" }>;
type MoveNodeInput = Extract<FigmaOperationInput, { type: "move_node" }>;
type SetSelectionInput = Extract<FigmaOperationInput, { type: "set_selection" }>;
type SetVariableInput = Extract<FigmaOperationInput, { type: "set_variable" }>;
type RunPluginActionInput = Extract<FigmaOperationInput, { type: "run_plugin_action" }>;

type WritableTextPatch = {
  characters?: string;
  fontName?: FontName;
  fontSize?: number;
};

function isParentNode(node: BaseNode | null): node is ChildrenMixin & BaseNode {
  return Boolean(node && "appendChild" in node);
}

function isSceneNode(node: BaseNode | null): node is SceneNode {
  return Boolean(node && "visible" in node);
}

function isGeometryMixin(node: SceneNode): node is SceneNode & GeometryMixin {
  return "fills" in node && "strokes" in node;
}

function isCornerMixin(node: SceneNode): node is SceneNode & CornerMixin {
  return "cornerRadius" in node;
}

function isLayoutMixin(node: SceneNode): node is SceneNode & BaseFrameMixin {
  return "layoutMode" in node;
}

function isTextNode(node: SceneNode): node is TextNode {
  return node.type === "TEXT";
}

function isResizable(node: SceneNode): node is SceneNode & LayoutMixin {
  return "resize" in node;
}

function assertSceneNode(node: BaseNode | null, nodeId: string): SceneNode {
  if (!isSceneNode(node)) {
    throw new Error(`Node ${nodeId} was not found or is not a SceneNode`);
  }
  return node;
}

async function ensureFontLoaded(node: TextNode, patch: WritableTextPatch): Promise<void> {
  const requestedFont = patch.fontName;
  if (requestedFont) {
    await figma.loadFontAsync(requestedFont);
    return;
  }

  if (patch.characters !== undefined || patch.fontSize !== undefined) {
    if (node.fontName === figma.mixed) {
      throw new Error("Cannot update text with mixed fonts unless patch.fontName is provided");
    }
    await figma.loadFontAsync(node.fontName);
  }
}

function applySharedProperties(node: SceneNode, patch: Record<string, unknown>): void {
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
  if ("rotation" in node && typeof patch.rotation === "number") {
    node.rotation = patch.rotation;
  }
  if ("opacity" in node && typeof patch.opacity === "number") {
    node.opacity = patch.opacity;
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
  if (isCornerMixin(node) && typeof patch.cornerRadius === "number") {
    node.cornerRadius = patch.cornerRadius;
  }
  if (isLayoutMixin(node) && typeof patch.layoutMode === "string") {
    node.layoutMode = patch.layoutMode as FrameNode["layoutMode"];
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

function createNodeFromSpec(spec: Record<string, unknown>): SceneNode {
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
      throw new Error(`Unsupported create_node type: ${String(spec.type)}`);
  }
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

function assertComponentNode(node: BaseNode | null, componentId: string): ComponentNode {
  if (!node || node.type !== "COMPONENT") {
    throw new Error(`Component ${componentId} was not found or is not a ComponentNode`);
  }
  return node;
}

export class FigmaAdapter implements ExecutorAdapter {
  async createNode(input: CreateNodeInput): Promise<ExecutorResult> {
    const node = createNodeFromSpec(input.node);
    await insertIntoParent(node, input.parentId, input.index);
    applySharedProperties(node, input.node);

    if (input.position) {
      node.x = input.position.x;
      node.y = input.position.y;
      if (isResizable(node)) {
        node.resize(input.position.width, input.position.height);
      }
    }

    if (isTextNode(node)) {
      const textPatch = input.node as WritableTextPatch;
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

  async createInstance(input: CreateInstanceInput): Promise<ExecutorResult> {
    const component = input.componentId
      ? assertComponentNode(await findNodeById(input.componentId), input.componentId)
      : await figma.importComponentByKeyAsync(input.componentKey!);

    const instance = component.createInstance();
    await insertIntoParent(instance, input.parentId, input.index);

    if (input.position) {
      instance.x = input.position.x;
      instance.y = input.position.y;
      if (isResizable(instance)) {
        instance.resize(input.position.width, input.position.height);
      }
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

  async updateNode(input: UpdateNodeInput): Promise<ExecutorResult> {
    const node = assertSceneNode(await findNodeById(input.nodeId), input.nodeId);
    applySharedProperties(node, input.patch);

    if (isTextNode(node)) {
      const textPatch = input.patch as WritableTextPatch;
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
      touchedNodeIds: [node.id]
    };
  }

  async deleteNode(input: DeleteNodeInput): Promise<ExecutorResult> {
    const node = assertSceneNode(await findNodeById(input.nodeId), input.nodeId);
    node.remove();
    return {
      touchedNodeIds: [input.nodeId]
    };
  }

  async moveNode(input: MoveNodeInput): Promise<ExecutorResult> {
    const node = assertSceneNode(await findNodeById(input.nodeId), input.nodeId);
    await insertIntoParent(node, input.parentId, input.index);
    if (input.position) {
      node.x = input.position.x;
      node.y = input.position.y;
    }
    return {
      touchedNodeIds: [node.id]
    };
  }

  async setSelection(input: SetSelectionInput): Promise<ExecutorResult> {
    const selection = (await Promise.all(input.selectionIds.map((nodeId) => findNodeById(nodeId)))).filter(isSceneNode);

    figma.currentPage.selection = selection;
    return {
      touchedNodeIds: selection.map((node) => node.id),
      result: {
        selectionCount: selection.length
      }
    };
  }

  async setVariable(input: SetVariableInput): Promise<ExecutorResult> {
    if (!figma.variables || !("getVariableByIdAsync" in figma.variables)) {
      throw new Error("Variables API is unavailable in this Figma environment");
    }

    const variable = await figma.variables.getVariableByIdAsync(input.variableId);
    if (!variable) {
      throw new Error(`Variable ${input.variableId} was not found`);
    }

    const modes = await figma.variables.getLocalVariableCollectionsAsync();
    const collection = modes.find((item) => item.id === variable.variableCollectionId);
    const modeId = collection?.defaultModeId;
    if (!modeId) {
      throw new Error(`Variable collection for ${input.variableId} has no default mode`);
    }

    variable.setValueForMode(modeId, input.value as VariableValue);
    return {
      touchedNodeIds: [],
      result: {
        variableId: variable.id
      }
    };
  }

  async runPluginAction(input: RunPluginActionInput): Promise<ExecutorResult> {
    switch (input.action) {
      case "scroll_into_view": {
        const targetId = typeof input.payload.nodeId === "string" ? input.payload.nodeId : undefined;
        if (!targetId) {
          throw new Error("run_plugin_action.scroll_into_view requires payload.nodeId");
        }
        const node = assertSceneNode(await findNodeById(targetId), targetId);
        figma.viewport.scrollAndZoomIntoView([node]);
        return {
          touchedNodeIds: [node.id]
        };
      }
      default:
        throw new Error(`Unsupported plugin action: ${input.action}`);
    }
  }
}
