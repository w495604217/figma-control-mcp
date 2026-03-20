import { describe, expect, it } from "vitest";

import { resolveBatchOperations } from "../src/batch-resolver.js";

// ---------------------------------------------------------------------------
// Test snapshot — a richer tree for Phase 2 selector testing
// ---------------------------------------------------------------------------

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
      childIds: ["button-1", "button-2", "hero-text"],
      pluginData: {}
    },
    {
      id: "footer",
      name: "Footer",
      type: "FRAME",
      parentId: "page-root",
      childIds: ["footer-text"],
      pluginData: {}
    },
    {
      id: "button-1",
      name: "Button",
      type: "FRAME",
      parentId: "hero",
      childIds: ["btn1-label"],
      pluginData: {}
    },
    {
      id: "button-2",
      name: "Button",
      type: "COMPONENT",
      parentId: "hero",
      childIds: [],
      pluginData: {}
    },
    {
      id: "hero-text",
      name: "Title",
      type: "TEXT",
      parentId: "hero",
      childIds: [],
      pluginData: {}
    },
    {
      id: "btn1-label",
      name: "Label",
      type: "TEXT",
      parentId: "button-1",
      childIds: [],
      pluginData: {}
    },
    {
      id: "footer-text",
      name: "Label",
      type: "TEXT",
      parentId: "footer",
      childIds: [],
      pluginData: {}
    },
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

// ---------------------------------------------------------------------------
// 1. Existing basic path syntax (backwards compat)
// ---------------------------------------------------------------------------

describe("resolveBatchOperations — backwards compatibility", () => {
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

// ---------------------------------------------------------------------------
// 2. Type-aware filtering (Name:TYPE)
// ---------------------------------------------------------------------------

describe("resolveBatchOperations — type-aware selectors", () => {
  it("resolves Name:TYPE to match only nodes of the given type", () => {
    // "Button" has two matches: button-1 (FRAME) and button-2 (COMPONENT)
    // "Button:COMPONENT" should match only button-2
    const result = resolveBatchOperations(snapshot, [
      {
        type: "update_node",
        nodePath: "Hero/Button:COMPONENT",
        patch: { name: "Component Button" }
      }
    ]);

    expect(result.errors).toHaveLength(0);
    expect(result.resolvedOperations[0]).toEqual({
      type: "update_node",
      nodeId: "button-2",
      patch: { name: "Component Button" }
    });
    // No ambiguity warning — type filter narrows to exactly 1
    expect(result.warnings).toHaveLength(0);
  });

  it("resolves Name:TYPE[N] for indexed typed match", () => {
    // "Button:FRAME" should match only button-1 (the FRAME one)
    const result = resolveBatchOperations(snapshot, [
      {
        type: "delete_node",
        nodePath: "Hero/Button:FRAME[1]"
      }
    ]);

    expect(result.errors).toHaveLength(0);
    expect(result.resolvedOperations[0]).toEqual({
      type: "delete_node",
      nodeId: "button-1"
    });
  });

  it("errors when Name:TYPE matches nothing", () => {
    const result = resolveBatchOperations(snapshot, [
      {
        type: "delete_node",
        nodePath: "Hero/Button:TEXT"
      }
    ]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("did not match any node");
  });
});

// ---------------------------------------------------------------------------
// 3. Wildcard selectors (*:TYPE)
// ---------------------------------------------------------------------------

describe("resolveBatchOperations — wildcard selectors", () => {
  it("resolves *:TYPE to match any child of the given type", () => {
    // Hero has children: Button(FRAME), Button(COMPONENT), Title(TEXT)
    // *:TEXT should match only hero-text ("Title")
    const result = resolveBatchOperations(snapshot, [
      {
        type: "update_node",
        nodePath: "Hero/*:TEXT",
        patch: { characters: "New Title" }
      }
    ]);

    expect(result.errors).toHaveLength(0);
    expect(result.resolvedOperations[0]).toEqual({
      type: "update_node",
      nodeId: "hero-text",
      patch: { characters: "New Title" }
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Recursive descendant (**)
// ---------------------------------------------------------------------------

describe("resolveBatchOperations — recursive descendant", () => {
  it("resolves **/ to find a deep descendant by name", () => {
    // "Hero/**/Label" should find btn1-label (Label inside Button inside Hero)
    const result = resolveBatchOperations(snapshot, [
      {
        type: "update_node",
        nodePath: "Hero/**/Label",
        patch: { characters: "Click me" }
      }
    ]);

    expect(result.errors).toHaveLength(0);
    expect(result.resolvedOperations[0]).toEqual({
      type: "update_node",
      nodeId: "btn1-label",
      patch: { characters: "Click me" }
    });
  });

  it("resolves **/Name:TYPE to find typed descendants", () => {
    // From root, find any TEXT node named "Label" → btn1-label or footer-text
    // Without index, should use first and warn about ambiguity
    const result = resolveBatchOperations(snapshot, [
      {
        type: "update_node",
        nodePath: "**/Label:TEXT",
        patch: { characters: "Updated" }
      }
    ]);

    expect(result.errors).toHaveLength(0);
    expect(result.resolvedOperations[0]).toEqual({
      type: "update_node",
      nodeId: expect.any(String),
      patch: { characters: "Updated" }
    });

    // Should warn about ambiguity (two Label:TEXT nodes exist)
    const ambiguityWarning = result.warnings.find((w) => w.message.includes("matched"));
    expect(ambiguityWarning).toBeDefined();
  });

  it("errors when ** is at the end without a following segment", () => {
    const result = resolveBatchOperations(snapshot, [
      {
        type: "delete_node",
        nodePath: "Hero/**"
      }
    ]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("must be followed by a concrete segment");
  });
});

// ---------------------------------------------------------------------------
// 5. Ambiguous match → structured warning
// ---------------------------------------------------------------------------

describe("resolveBatchOperations — ambiguity handling", () => {
  it("warns when multiple nodes match a selector without explicit index", () => {
    // "Hero/Button" matches button-1 and button-2
    const result = resolveBatchOperations(snapshot, [
      {
        type: "update_node",
        nodePath: "Hero/Button",
        patch: { name: "Renamed" }
      }
    ]);

    // Should still succeed (backwards compat — picks first)
    expect(result.errors).toHaveLength(0);
    expect(result.resolvedOperations).toHaveLength(1);
    expect(result.resolvedOperations[0]).toEqual({
      type: "update_node",
      nodeId: "button-1",
      patch: { name: "Renamed" }
    });

    // Should produce an ambiguity warning
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.message).toContain("matched 2 nodes");
    expect(result.warnings[0]?.message).toContain("button-1");
    expect(result.warnings[0]?.message).toContain("button-2");
    expect(result.warnings[0]?.message).toContain("disambiguate");
  });

  it("does not warn when explicit index is used", () => {
    const result = resolveBatchOperations(snapshot, [
      {
        type: "update_node",
        nodePath: "Hero/Button[1]",
        patch: { name: "First Button" }
      }
    ]);

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.resolvedOperations[0]).toEqual({
      type: "update_node",
      nodeId: "button-1",
      patch: { name: "First Button" }
    });
  });

  it("does not warn when type filter narrows to one match", () => {
    const result = resolveBatchOperations(snapshot, [
      {
        type: "update_node",
        nodePath: "Hero/Button:COMPONENT",
        patch: { name: "Comp Button" }
      }
    ]);

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Missing selector → structured error
// ---------------------------------------------------------------------------

describe("resolveBatchOperations — structured errors", () => {
  it("returns structured error for non-existent path", () => {
    const result = resolveBatchOperations(snapshot, [
      {
        type: "update_node",
        nodePath: "NonExistent/Child",
        patch: { name: "x" }
      }
    ]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.index).toBe(0);
    expect(result.errors[0]?.message).toContain("did not match any node");
  });

  it("returns structured error for non-existent node id", () => {
    const result = resolveBatchOperations(snapshot, [
      {
        type: "update_node",
        nodeId: "does-not-exist",
        patch: { name: "x" }
      }
    ]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("was not found");
    expect(result.errors[0]?.message).toContain("nodes available");
  });

  it("returns structured error for out-of-range occurrence", () => {
    const result = resolveBatchOperations(snapshot, [
      {
        type: "delete_node",
        nodePath: "Hero/Button[99]"
      }
    ]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("occurrence 99");
    expect(result.errors[0]?.message).toContain("match(es) exist");
  });
});

// ---------------------------------------------------------------------------
// 7. Direct id selection (#id)
// ---------------------------------------------------------------------------

describe("resolveBatchOperations — direct id selection", () => {
  it("resolves #id standalone selectors", () => {
    const result = resolveBatchOperations(snapshot, [
      {
        type: "update_node",
        nodePath: "#hero",
        patch: { name: "Hero Section" }
      }
    ]);

    expect(result.errors).toHaveLength(0);
    expect(result.resolvedOperations[0]).toEqual({
      type: "update_node",
      nodeId: "hero",
      patch: { name: "Hero Section" }
    });
  });

  it("resolves #id within a path", () => {
    // #hero/Button should resolve Button children of Hero via id addressing
    const result = resolveBatchOperations(snapshot, [
      {
        type: "update_node",
        nodePath: "#hero/Button[1]",
        patch: { name: "Button via id parent" }
      }
    ]);

    expect(result.errors).toHaveLength(0);
    expect(result.resolvedOperations[0]).toEqual({
      type: "update_node",
      nodeId: "button-1",
      patch: { name: "Button via id parent" }
    });
  });

  it("errors for non-existent #id", () => {
    const result = resolveBatchOperations(snapshot, [
      {
        type: "delete_node",
        nodePath: "#nonexistent"
      }
    ]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No node found");
  });
});

// ---------------------------------------------------------------------------
// 8. Resolution diagnostics in summary
// ---------------------------------------------------------------------------

describe("resolveBatchOperations — resolution diagnostics", () => {
  it("includes selectorUsed and matchCount in resolution summary", () => {
    const result = resolveBatchOperations(snapshot, [
      {
        type: "update_node",
        nodePath: "Hero/Button:FRAME",
        patch: { name: "Updated" }
      }
    ]);

    expect(result.resolutions).toHaveLength(1);
    const summary = result.resolutions[0]!;
    expect(summary.selectorUsed).toBe("Hero/Button:FRAME");
    expect(summary.resolvedNodeId).toBe("button-1");
    expect(summary.matchCount).toBe(1);
    expect(summary.matchedNodeIds).toEqual(["button-1"]);
  });

  it("includes ambiguous match info in resolution summary", () => {
    const result = resolveBatchOperations(snapshot, [
      {
        type: "update_node",
        nodePath: "Hero/Button",
        patch: { name: "Ambiguous" }
      }
    ]);

    expect(result.resolutions).toHaveLength(1);
    const summary = result.resolutions[0]!;
    expect(summary.selectorUsed).toBe("Hero/Button");
    expect(summary.matchCount).toBe(2);
    expect(summary.matchedNodeIds).toEqual(["button-1", "button-2"]);
  });
});

// ---------------------------------------------------------------------------
// 9. Ambiguity propagation to parentPath and selectionPaths
// ---------------------------------------------------------------------------

describe("resolveBatchOperations — parentPath ambiguity propagation", () => {
  it("warns on ambiguous parentPath for create_node", () => {
    // Use a snapshot where root has two children named "Hero"
    const ambiguousSnapshot = {
      sessionId: "session-1",
      pageName: "Page 1",
      selectionIds: [],
      nodes: [
        {
          id: "hero-a", name: "Hero", type: "FRAME",
          parentId: "page-root", childIds: [], pluginData: {}
        },
        {
          id: "hero-b", name: "Hero", type: "FRAME",
          parentId: "page-root", childIds: [], pluginData: {}
        },
      ],
      variables: [],
      components: []
    };

    const result = resolveBatchOperations(ambiguousSnapshot, [
      {
        type: "create_node",
        parentPath: "Hero",
        node: { type: "TEXT", name: "Label" }
      }
    ]);

    expect(result.errors).toHaveLength(0);
    expect(result.resolvedOperations).toHaveLength(1);

    // Should produce an ambiguity warning for parentPath
    const ambiguityWarning = result.warnings.find((w) => w.message.includes("matched 2 nodes"));
    expect(ambiguityWarning).toBeDefined();
    expect(ambiguityWarning?.message).toContain("hero-a");
    expect(ambiguityWarning?.message).toContain("hero-b");
  });
});

describe("resolveBatchOperations — selectionPaths ambiguity propagation", () => {
  it("warns on ambiguous selectionPaths", () => {
    // "Hero/Button" matches button-1 and button-2 => ambiguity warning
    const result = resolveBatchOperations(snapshot, [
      {
        type: "set_selection",
        selectionPaths: ["Hero/Button"]
      }
    ]);

    expect(result.errors).toHaveLength(0);
    expect(result.resolvedOperations).toHaveLength(1);
    expect(result.resolvedOperations[0]).toEqual({
      type: "set_selection",
      selectionIds: ["button-1"]
    });

    // Should produce an ambiguity warning
    const ambiguityWarning = result.warnings.find((w) => w.message.includes("matched 2 nodes"));
    expect(ambiguityWarning).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 10. Case-insensitive type filter
// ---------------------------------------------------------------------------

describe("resolveBatchOperations — case-insensitive type filter", () => {
  it("accepts lowercase type filter and normalizes to uppercase", () => {
    const result = resolveBatchOperations(snapshot, [
      {
        type: "update_node",
        nodePath: "Hero/Button:component",
        patch: { name: "Found via Lowercase" }
      }
    ]);

    expect(result.errors).toHaveLength(0);
    expect(result.resolvedOperations[0]).toEqual({
      type: "update_node",
      nodeId: "button-2",
      patch: { name: "Found via Lowercase" }
    });
  });

  it("accepts mixed-case type filter", () => {
    const result = resolveBatchOperations(snapshot, [
      {
        type: "update_node",
        nodePath: "Hero/Button:Frame",
        patch: { name: "Found via MixedCase" }
      }
    ]);

    expect(result.errors).toHaveLength(0);
    expect(result.resolvedOperations[0]).toEqual({
      type: "update_node",
      nodeId: "button-1",
      patch: { name: "Found via MixedCase" }
    });
  });
});

// ---------------------------------------------------------------------------
// 11. #id:TYPE support
// ---------------------------------------------------------------------------

describe("resolveBatchOperations — #id:TYPE selectors", () => {
  it("supports #id:TYPE when type matches", () => {
    const result = resolveBatchOperations(snapshot, [
      {
        type: "update_node",
        nodePath: "#hero:FRAME",
        patch: { name: "ID + Type" }
      }
    ]);

    expect(result.errors).toHaveLength(0);
    expect(result.resolvedOperations[0]).toEqual({
      type: "update_node",
      nodeId: "hero",
      patch: { name: "ID + Type" }
    });
  });

  it("rejects #id:TYPE when type does not match", () => {
    const result = resolveBatchOperations(snapshot, [
      {
        type: "update_node",
        nodePath: "#hero:TEXT",
        patch: { name: "Wrong Type" }
      }
    ]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("has type");
    expect(result.errors[0]?.message).toContain("not \"TEXT\"");
  });

  it("supports #id:TYPE in path segments", () => {
    // #hero:FRAME/Button[1] — use typed id segment as parent
    const result = resolveBatchOperations(snapshot, [
      {
        type: "update_node",
        nodePath: "#hero:FRAME/Button[1]",
        patch: { name: "Via typed id parent" }
      }
    ]);

    expect(result.errors).toHaveLength(0);
    expect(result.resolvedOperations[0]).toEqual({
      type: "update_node",
      nodeId: "button-1",
      patch: { name: "Via typed id parent" }
    });
  });
});
