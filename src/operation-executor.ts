import type { FigmaOperationInput } from "./schemas.js";

type JsonRecord = Record<string, unknown>;

export type ExecutorResult = {
  touchedNodeIds: string[];
  result?: JsonRecord;
};

export type ExecutorAdapter = {
  createNode(input: Extract<FigmaOperationInput, { type: "create_node" }>): Promise<ExecutorResult>;
  createInstance(input: Extract<FigmaOperationInput, { type: "create_instance" }>): Promise<ExecutorResult>;
  updateNode(input: Extract<FigmaOperationInput, { type: "update_node" }>): Promise<ExecutorResult>;
  deleteNode(input: Extract<FigmaOperationInput, { type: "delete_node" }>): Promise<ExecutorResult>;
  moveNode(input: Extract<FigmaOperationInput, { type: "move_node" }>): Promise<ExecutorResult>;
  setSelection(input: Extract<FigmaOperationInput, { type: "set_selection" }>): Promise<ExecutorResult>;
  setVariable(input: Extract<FigmaOperationInput, { type: "set_variable" }>): Promise<ExecutorResult>;
  runPluginAction(input: Extract<FigmaOperationInput, { type: "run_plugin_action" }>): Promise<ExecutorResult>;
};

export async function executeOperation(
  adapter: ExecutorAdapter,
  operation: FigmaOperationInput
): Promise<ExecutorResult> {
  switch (operation.type) {
    case "create_node":
      return adapter.createNode(operation);
    case "create_instance":
      return adapter.createInstance(operation);
    case "update_node":
      return adapter.updateNode(operation);
    case "delete_node":
      return adapter.deleteNode(operation);
    case "move_node":
      return adapter.moveNode(operation);
    case "set_selection":
      return adapter.setSelection(operation);
    case "set_variable":
      return adapter.setVariable(operation);
    case "run_plugin_action":
      return adapter.runPluginAction(operation);
    default: {
      const exhaustiveCheck: never = operation;
      throw new Error(`Unsupported operation: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
