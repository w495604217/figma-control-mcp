import { z } from "zod";

export const figmaBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number()
});

export const figmaNodeSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  type: z.string(),
  parentId: z.string().optional(),
  childIds: z.array(z.string()).default([]),
  visible: z.boolean().optional(),
  locked: z.boolean().optional(),
  bounds: figmaBoundsSchema.optional(),
  componentId: z.string().optional(),
  componentSetId: z.string().optional(),
  pluginData: z.record(z.string(), z.unknown()).default({})
});

export const figmaVariableSchema = z.object({
  id: z.string(),
  name: z.string(),
  collectionId: z.string().optional(),
  resolvedType: z.string(),
  value: z.unknown().optional()
});

export const figmaComponentSummarySchema = z.object({
  id: z.string(),
  key: z.string().optional(),
  name: z.string(),
  nodeId: z.string().optional(),
  pageId: z.string().optional(),
  pageName: z.string().optional(),
  description: z.string().optional(),
  componentSetId: z.string().optional()
});

export const figmaSnapshotSchema = z.object({
  sessionId: z.string(),
  fileKey: z.string().optional(),
  fileName: z.string().optional(),
  pageId: z.string().optional(),
  pageName: z.string().optional(),
  selectionIds: z.array(z.string()).default([]),
  nodes: z.array(figmaNodeSchema).default([]),
  variables: z.array(figmaVariableSchema).default([]),
  components: z.array(figmaComponentSummarySchema).default([]),
  capturedAt: z.string().datetime().optional(),
  raw: z.record(z.string(), z.unknown()).optional()
});

export const figmaSessionSchema = z.object({
  sessionId: z.string(),
  fileKey: z.string().optional(),
  fileName: z.string().optional(),
  pageId: z.string().optional(),
  pageName: z.string().optional(),
  selectionIds: z.array(z.string()).default([]),
  pluginVersion: z.string().optional(),
  bridgeVersion: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  connectedAt: z.string().datetime().optional(),
  lastHeartbeatAt: z.string().datetime().optional()
});

export const figmaNodeReferenceSchema = z.object({
  nodeId: z.string().optional(),
  nodePath: z.string().optional()
}).refine((value) => Boolean(value.nodeId || value.nodePath), {
  message: "Either nodeId or nodePath is required"
});

export const figmaVariableReferenceSchema = z.object({
  variableId: z.string().optional(),
  variableName: z.string().optional()
}).refine((value) => Boolean(value.variableId || value.variableName), {
  message: "Either variableId or variableName is required"
});

const createNodeOperationSchema = z.object({
  type: z.literal("create_node"),
  parentId: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
  node: z.record(z.string(), z.unknown()),
  position: figmaBoundsSchema.optional()
});

const createInstanceOperationSchema = z.object({
  type: z.literal("create_instance"),
  componentId: z.string().optional(),
  componentKey: z.string().optional(),
  parentId: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
  position: figmaBoundsSchema.optional()
}).refine((value) => Boolean(value.componentId || value.componentKey), {
  message: "create_instance requires componentId or componentKey"
});

const updateNodeOperationSchema = z.object({
  type: z.literal("update_node"),
  nodeId: z.string(),
  patch: z.record(z.string(), z.unknown())
});

const deleteNodeOperationSchema = z.object({
  type: z.literal("delete_node"),
  nodeId: z.string()
});

const moveNodeOperationSchema = z.object({
  type: z.literal("move_node"),
  nodeId: z.string(),
  parentId: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
  position: figmaBoundsSchema.optional()
});

const setVariableOperationSchema = z.object({
  type: z.literal("set_variable"),
  variableId: z.string(),
  value: z.unknown()
});

const setSelectionOperationSchema = z.object({
  type: z.literal("set_selection"),
  selectionIds: z.array(z.string())
});

const runPluginActionOperationSchema = z.object({
  type: z.literal("run_plugin_action"),
  action: z.string(),
  payload: z.record(z.string(), z.unknown()).default({})
});

export const figmaOperationInputSchema = z.discriminatedUnion("type", [
  createNodeOperationSchema,
  createInstanceOperationSchema,
  updateNodeOperationSchema,
  deleteNodeOperationSchema,
  moveNodeOperationSchema,
  setVariableOperationSchema,
  setSelectionOperationSchema,
  runPluginActionOperationSchema
]);

export const enqueueOperationsSchema = z.object({
  sessionId: z.string(),
  clientRequestId: z.string().optional(),
  description: z.string().optional(),
  operations: z.array(figmaOperationInputSchema).min(1)
});

const createNodeBatchOperationSchema = z.object({
  type: z.literal("create_node"),
  parentId: z.string().optional(),
  parentPath: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
  node: z.record(z.string(), z.unknown()),
  position: figmaBoundsSchema.optional()
});

const createInstanceBatchOperationSchema = z.object({
  type: z.literal("create_instance"),
  componentId: z.string().optional(),
  componentKey: z.string().optional(),
  parentId: z.string().optional(),
  parentPath: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
  position: figmaBoundsSchema.optional()
}).refine((value) => Boolean(value.componentId || value.componentKey), {
  message: "create_instance requires componentId or componentKey"
});

const updateNodeBatchOperationSchema = z.object({
  type: z.literal("update_node"),
  nodeId: z.string().optional(),
  nodePath: z.string().optional(),
  patch: z.record(z.string(), z.unknown())
}).refine((value) => Boolean(value.nodeId || value.nodePath), {
  message: "update_node requires nodeId or nodePath"
});

const deleteNodeBatchOperationSchema = z.object({
  type: z.literal("delete_node"),
  nodeId: z.string().optional(),
  nodePath: z.string().optional()
}).refine((value) => Boolean(value.nodeId || value.nodePath), {
  message: "delete_node requires nodeId or nodePath"
});

const moveNodeBatchOperationSchema = z.object({
  type: z.literal("move_node"),
  nodeId: z.string().optional(),
  nodePath: z.string().optional(),
  parentId: z.string().optional(),
  parentPath: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
  position: figmaBoundsSchema.optional()
}).refine((value) => Boolean(value.nodeId || value.nodePath), {
  message: "move_node requires nodeId or nodePath"
});

const setVariableBatchOperationSchema = z.object({
  type: z.literal("set_variable"),
  variableId: z.string().optional(),
  variableName: z.string().optional(),
  value: z.unknown()
}).refine((value) => Boolean(value.variableId || value.variableName), {
  message: "set_variable requires variableId or variableName"
});

const setSelectionBatchOperationSchema = z.object({
  type: z.literal("set_selection"),
  selectionIds: z.array(z.string()).optional(),
  selectionPaths: z.array(z.string()).optional()
}).refine((value) => {
  const idCount = value.selectionIds?.length ?? 0;
  const pathCount = value.selectionPaths?.length ?? 0;
  return idCount + pathCount > 0;
}, {
  message: "set_selection requires selectionIds or selectionPaths"
});

const runPluginActionBatchOperationSchema = z.object({
  type: z.literal("run_plugin_action"),
  action: z.string(),
  payload: z.record(z.string(), z.unknown()).default({})
});

export const figmaBatchOperationInputSchema = z.discriminatedUnion("type", [
  createNodeBatchOperationSchema,
  createInstanceBatchOperationSchema,
  updateNodeBatchOperationSchema,
  deleteNodeBatchOperationSchema,
  moveNodeBatchOperationSchema,
  setVariableBatchOperationSchema,
  setSelectionBatchOperationSchema,
  runPluginActionBatchOperationSchema
]);

export const enqueueBatchOperationsSchema = z.object({
  sessionId: z.string(),
  clientRequestId: z.string().optional(),
  description: z.string().optional(),
  operations: z.array(figmaBatchOperationInputSchema).min(1)
});

export const talkToFigmaProbeSchema = z.object({
  channel: z.string().min(1),
  wsUrl: z.string().url().optional(),
  timeoutMs: z.number().int().positive().max(120000).default(10000)
});

export const talkToFigmaCommandSchema = z.object({
  channel: z.string().min(1),
  command: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  wsUrl: z.string().url().optional(),
  timeoutMs: z.number().int().positive().max(300000).default(30000)
});

export const pullOperationsSchema = z.object({
  sessionId: z.string(),
  limit: z.number().int().positive().max(100).default(20)
});

export const operationStatusSchema = z.enum([
  "queued",
  "dispatched",
  "succeeded",
  "failed"
]);

export const acknowledgeOperationsSchema = z.object({
  sessionId: z.string(),
  updates: z.array(
    z.object({
      operationId: z.string(),
      status: operationStatusSchema.exclude(["queued"]),
      error: z.string().optional(),
      result: z.record(z.string(), z.unknown()).optional(),
      touchedNodeIds: z.array(z.string()).default([])
    })
  ).min(1)
});

export const figmaOperationRecordSchema = z.object({
  operationId: z.string(),
  batchId: z.string().optional(),
  sessionId: z.string(),
  clientRequestId: z.string().optional(),
  description: z.string().optional(),
  status: operationStatusSchema,
  operation: figmaOperationInputSchema,
  createdAt: z.string().datetime(),
  dispatchedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  error: z.string().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  touchedNodeIds: z.array(z.string()).default([])
});

export const bridgeStateSchema = z.object({
  sessions: z.record(z.string(), figmaSessionSchema).default({}),
  snapshots: z.record(z.string(), figmaSnapshotSchema).default({}),
  operations: z.record(z.string(), figmaOperationRecordSchema).default({})
});

export type FigmaBounds = z.infer<typeof figmaBoundsSchema>;
export type FigmaNode = z.infer<typeof figmaNodeSchema>;
export type FigmaVariable = z.infer<typeof figmaVariableSchema>;
export type FigmaComponentSummary = z.infer<typeof figmaComponentSummarySchema>;
export type FigmaSnapshot = z.infer<typeof figmaSnapshotSchema>;
export type FigmaSession = z.infer<typeof figmaSessionSchema>;
export type FigmaNodeReference = z.infer<typeof figmaNodeReferenceSchema>;
export type FigmaVariableReference = z.infer<typeof figmaVariableReferenceSchema>;
export type FigmaOperationInput = z.infer<typeof figmaOperationInputSchema>;
export type FigmaBatchOperationInput = z.infer<typeof figmaBatchOperationInputSchema>;
export type FigmaOperationRecord = z.infer<typeof figmaOperationRecordSchema>;
export type TalkToFigmaProbeInput = z.infer<typeof talkToFigmaProbeSchema>;
export type TalkToFigmaCommandInput = z.infer<typeof talkToFigmaCommandSchema>;
export type BridgeState = z.infer<typeof bridgeStateSchema>;
