import type { FigmaComponentSummary, FigmaSnapshot, FigmaNode, FigmaVariable } from "../../src/schemas.js";

function serializeNode(node: SceneNode): FigmaNode {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    parentId: "parent" in node && node.parent ? node.parent.id : undefined,
    childIds: "children" in node ? node.children.map((child) => child.id) : [],
    pluginData: {},
    visible: "visible" in node ? node.visible : undefined,
    locked: "locked" in node ? node.locked : undefined,
    bounds: "absoluteBoundingBox" in node && node.absoluteBoundingBox
      ? {
          x: node.absoluteBoundingBox.x,
          y: node.absoluteBoundingBox.y,
          width: node.absoluteBoundingBox.width,
          height: node.absoluteBoundingBox.height
        }
      : undefined,
    componentId: "componentId" in node && typeof node.componentId === "string" ? node.componentId : undefined,
    componentSetId:
      "componentSetId" in node && typeof node.componentSetId === "string" ? node.componentSetId : undefined
  };
}

async function getVariables(): Promise<FigmaVariable[]> {
  if (!figma.variables || !("getLocalVariablesAsync" in figma.variables)) {
    return [];
  }

  const variables = await figma.variables.getLocalVariablesAsync();
  return variables.map((variable) => ({
    id: variable.id,
    name: variable.name,
    collectionId: variable.variableCollectionId,
    resolvedType: variable.resolvedType
  }));
}

async function getPublishedComponents(): Promise<FigmaComponentSummary[]> {
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

export async function captureSnapshot(sessionId: string): Promise<FigmaSnapshot> {
  const nodes = figma.currentPage.findAll();
  const variables = await getVariables();
  const components = await getPublishedComponents();

  return {
    sessionId,
    fileKey: figma.fileKey,
    fileName: figma.root.name,
    pageId: figma.currentPage.id,
    pageName: figma.currentPage.name,
    selectionIds: figma.currentPage.selection.map((node) => node.id),
    nodes: nodes.map(serializeNode),
    variables,
    components,
    capturedAt: new Date().toISOString()
  };
}
