import { describe, expect, it, vi } from "vitest";

import { executeOperation, type ExecutorAdapter } from "../plugin-example/src/executor.js";

function createAdapter(): ExecutorAdapter {
  return {
    createNode: vi.fn(async () => ({ touchedNodeIds: ["created"] })),
    createInstance: vi.fn(async () => ({ touchedNodeIds: ["instance"] })),
    updateNode: vi.fn(async () => ({ touchedNodeIds: ["updated"] })),
    deleteNode: vi.fn(async () => ({ touchedNodeIds: ["deleted"] })),
    moveNode: vi.fn(async () => ({ touchedNodeIds: ["moved"] })),
    setSelection: vi.fn(async () => ({ touchedNodeIds: ["selected"] })),
    setVariable: vi.fn(async () => ({ touchedNodeIds: [] })),
    runPluginAction: vi.fn(async () => ({ touchedNodeIds: ["action"] }))
  };
}

describe("executeOperation", () => {
  it("routes create_node to adapter.createNode", async () => {
    const adapter = createAdapter();
    const result = await executeOperation(adapter, {
      type: "create_node",
      node: { type: "FRAME", name: "Hero" }
    });

    expect(result.touchedNodeIds).toEqual(["created"]);
    expect(adapter.createNode).toHaveBeenCalledOnce();
  });

  it("routes update_node to adapter.updateNode", async () => {
    const adapter = createAdapter();
    await executeOperation(adapter, {
      type: "update_node",
      nodeId: "1:1",
      patch: { name: "New name" }
    });

    expect(adapter.updateNode).toHaveBeenCalledOnce();
  });

  it("routes create_instance to adapter.createInstance", async () => {
    const adapter = createAdapter();
    const result = await executeOperation(adapter, {
      type: "create_instance",
      componentKey: "component-key-1"
    });

    expect(result.touchedNodeIds).toEqual(["instance"]);
    expect(adapter.createInstance).toHaveBeenCalledOnce();
  });

  it("routes run_plugin_action to adapter.runPluginAction", async () => {
    const adapter = createAdapter();
    await executeOperation(adapter, {
      type: "run_plugin_action",
      action: "scroll_into_view",
      payload: { nodeId: "1:1" }
    });

    expect(adapter.runPluginAction).toHaveBeenCalledOnce();
  });
});
