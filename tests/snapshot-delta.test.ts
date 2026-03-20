import { describe, expect, it } from "vitest";

import { diffSnapshots } from "../src/snapshot-delta.js";

describe("snapshot-delta", () => {
  it("reports added nodes and selection changes", () => {
    const delta = diffSnapshots({
      sessionId: "talk-to-figma:test",
      selectionIds: ["1:1"],
      nodes: [
        { id: "1:1", name: "Old", type: "FRAME", childIds: [], pluginData: {} }
      ],
      variables: [],
      components: []
    }, {
      sessionId: "talk-to-figma:test",
      selectionIds: ["2:1"],
      nodes: [
        { id: "1:1", name: "Old", type: "FRAME", childIds: [], pluginData: {} },
        { id: "2:1", name: "New", type: "INSTANCE", childIds: [], pluginData: {} }
      ],
      variables: [],
      components: []
    });

    expect(delta.addedNodes.map((node) => node.id)).toEqual(["2:1"]);
    expect(delta.removedNodeIds).toEqual([]);
    expect(delta.addedSelectionIds).toEqual(["2:1"]);
    expect(delta.removedSelectionIds).toEqual(["1:1"]);
  });
});
