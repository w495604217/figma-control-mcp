import type { FigmaNode, FigmaSnapshot } from "./schemas.js";

export type FigmaSnapshotDelta = {
  addedNodes: FigmaNode[];
  removedNodeIds: string[];
  addedSelectionIds: string[];
  removedSelectionIds: string[];
};

export function diffSnapshots(before: FigmaSnapshot | null, after: FigmaSnapshot): FigmaSnapshotDelta {
  const beforeNodeIds = new Set((before?.nodes ?? []).map((node) => node.id));
  const afterNodeIds = new Set(after.nodes.map((node) => node.id));
  const beforeSelection = new Set(before?.selectionIds ?? []);
  const afterSelection = new Set(after.selectionIds);

  return {
    addedNodes: after.nodes.filter((node) => !beforeNodeIds.has(node.id)),
    removedNodeIds: [...beforeNodeIds].filter((nodeId) => !afterNodeIds.has(nodeId)),
    addedSelectionIds: [...afterSelection].filter((nodeId) => !beforeSelection.has(nodeId)),
    removedSelectionIds: [...beforeSelection].filter((nodeId) => !afterSelection.has(nodeId))
  };
}
