import { describe, expect, it } from "vitest";

import { resolveBatchOperations } from "../src/batch-resolver.js";

const snapshot = {
  sessionId: "session-1",
  pageName: "Page 1",
  selectionIds: [],
  nodes: [
    {
      id: "hero",
      name: "Hero",
      type: "FRAME",
      parentId: "page-root",
      childIds: ["button-1", "button-2"],
      pluginData: {}
    },
    {
      id: "footer",
      name: "Footer",
      type: "FRAME",
      parentId: "page-root",
      childIds: [],
      pluginData: {}
    },
    {
      id: "button-1",
      name: "Button",
      type: "FRAME",
      parentId: "hero",
      childIds: [],
      pluginData: {}
    },
    {
      id: "button-2",
      name: "Button",
      type: "FRAME",
      parentId: "hero",
      childIds: [],
      pluginData: {}
    }
  ],
  variables: [
    {
      id: "color-primary",
      name: "Color / Primary",
      resolvedType: "COLOR"
    }
  ],
  components: []
};

describe("resolveBatchOperations", () => {
  it("resolves node paths and variable names into concrete operations", () => {
    const result = resolveBatchOperations(snapshot, [
      {
        type: "update_node",
        nodePath: "Hero/Button[2]",
        patch: { name: "Secondary Button" }
      },
      {
        type: "set_variable",
        variableName: "Color / Primary",
        value: { r: 1, g: 0, b: 0 }
      }
    ]);

    expect(result.errors).toHaveLength(0);
    expect(result.resolvedOperations[0]).toEqual({
      type: "update_node",
      nodeId: "button-2",
      patch: { name: "Secondary Button" }
    });
    expect(result.resolvedOperations[1]).toEqual({
      type: "set_variable",
      variableId: "color-primary",
      value: { r: 1, g: 0, b: 0 }
    });
  });

  it("resolves create_instance parent paths into concrete operations", () => {
    const result = resolveBatchOperations(snapshot, [
      {
        type: "create_instance",
        componentKey: "component-key-1",
        parentPath: "Footer"
      }
    ]);

    expect(result.errors).toHaveLength(0);
    expect(result.resolvedOperations[0]).toEqual({
      type: "create_instance",
      componentKey: "component-key-1",
      componentId: undefined,
      parentId: "footer",
      index: undefined,
      position: undefined
    });
  });

  it("supports SECTION create nodes and warns on ignored fields", () => {
    const result = resolveBatchOperations(snapshot, [
      {
        type: "create_node",
        parentPath: "Hero",
        node: { type: "SECTION", name: "Marketing Section", unsupportedField: true }
      }
    ]);

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.message).toContain("unsupportedField");
    expect(result.resolvedOperations[0]).toEqual({
      type: "create_node",
      parentId: "hero",
      node: { type: "SECTION", name: "Marketing Section", unsupportedField: true },
      position: undefined
    });
  });

  it("reports missing snapshots clearly", () => {
    const result = resolveBatchOperations(null, [
      {
        type: "delete_node",
        nodePath: "Hero/Button"
      }
    ]);

    expect(result.errors[0]?.message).toContain("No snapshot");
  });
});
