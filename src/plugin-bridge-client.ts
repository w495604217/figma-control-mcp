import type {
  FigmaBatchOperationInput,
  FigmaOperationInput,
  FigmaOperationRecord,
  FigmaSnapshot,
  FigmaSession
} from "./schemas.js";
import type { TraceRecord, TraceFlowType } from "./trace-store.js";

type BridgeClientOptions = {
  baseUrl?: string;
  token?: string;
  fetchFn?: typeof fetch;
};

type JsonRecord = Record<string, unknown>;

export class PluginBridgeClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: BridgeClientOptions = {}) {
    const fallbackFetch = options.fetchFn ?? (typeof fetch === "function"
      ? fetch.bind(undefined) as typeof fetch
      : undefined);

    if (!fallbackFetch) {
      throw new Error("fetch is unavailable in the current Figma runtime");
    }

    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:3847").replace(/\/$/, "");
    this.token = options.token;
    this.fetchFn = fallbackFetch;
  }

  async health(): Promise<{ ok: boolean }> {
    return this.request("/healthz", { method: "GET" });
  }

  async registerSession(session: FigmaSession): Promise<FigmaSession> {
    return this.request("/bridge/register-session", {
      method: "POST",
      body: session
    });
  }

  async publishSnapshot(snapshot: FigmaSnapshot): Promise<FigmaSnapshot> {
    return this.request("/bridge/snapshot", {
      method: "POST",
      body: snapshot
    });
  }

  async pullOperations(sessionId: string, limit = 20): Promise<{ count: number; operations: FigmaOperationRecord[] }> {
    return this.request("/bridge/pull-operations", {
      method: "POST",
      body: { sessionId, limit }
    });
  }

  async acknowledge(
    sessionId: string,
    updates: Array<{
      operationId: string;
      status: "dispatched" | "succeeded" | "failed" | "skipped";
      error?: string;
      result?: JsonRecord;
      touchedNodeIds?: string[];
    }>
  ): Promise<{ count: number; operations: FigmaOperationRecord[] }> {
    return this.request("/bridge/acknowledge", {
      method: "POST",
      body: { sessionId, updates }
    });
  }

  async status(sessionId?: string): Promise<{ sessions: FigmaSession[]; operations: FigmaOperationRecord[] }> {
    const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    return this.request(`/bridge/status${suffix}`, { method: "GET" });
  }

  async searchComponents(input: {
    query?: string;
    sessionId?: string;
    limit?: number;
  } = {}): Promise<{
    count: number;
    components: Array<Record<string, unknown>>;
  }> {
    const params = new URLSearchParams();
    if (input.query) {
      params.set("query", input.query);
    }
    if (input.sessionId) {
      params.set("sessionId", input.sessionId);
    }
    if (typeof input.limit === "number") {
      params.set("limit", String(input.limit));
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request(`/bridge/components${suffix}`, { method: "GET" });
  }

  async searchPublishedComponents(input: {
    query: string;
    sourceSessionId?: string;
    fileKey?: string;
    limit?: number;
    includeComponentSets?: boolean;
  }): Promise<{
    count: number;
    components: Array<Record<string, unknown>>;
  }> {
    const params = new URLSearchParams();
    params.set("query", input.query);
    if (input.sourceSessionId) {
      params.set("sourceSessionId", input.sourceSessionId);
    }
    if (input.fileKey) {
      params.set("fileKey", input.fileKey);
    }
    if (typeof input.limit === "number") {
      params.set("limit", String(input.limit));
    }
    if (typeof input.includeComponentSets === "boolean") {
      params.set("includeComponentSets", String(input.includeComponentSets));
    }
    return this.request(`/bridge/published-components?${params.toString()}`, { method: "GET" });
  }

  async scanAssetsPanel(input: {
    activateApp?: boolean;
    limit?: number;
  } = {}): Promise<{
    count: number;
    libraries: Array<Record<string, unknown>>;
    image?: string;
  }> {
    const params = new URLSearchParams();
    if (typeof input.activateApp === "boolean") {
      params.set("activateApp", String(input.activateApp));
    }
    if (typeof input.limit === "number") {
      params.set("limit", String(input.limit));
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request(`/bridge/assets-panel${suffix}`, { method: "GET" });
  }

  async searchAssetsPanel(input: {
    query: string;
    activateApp?: boolean;
    limit?: number;
    windowTitle?: string;
    settleMs?: number;
  }): Promise<{
    query: string;
    image?: string;
    window: Record<string, unknown>;
    searchFieldPt: Record<string, unknown>;
    dropTargetPt: Record<string, unknown>;
    count: number;
    matches: Array<Record<string, unknown>>;
  }> {
    const params = new URLSearchParams();
    params.set("query", input.query);
    if (typeof input.activateApp === "boolean") {
      params.set("activateApp", String(input.activateApp));
    }
    if (typeof input.limit === "number") {
      params.set("limit", String(input.limit));
    }
    if (input.windowTitle) {
      params.set("windowTitle", input.windowTitle);
    }
    if (typeof input.settleMs === "number") {
      params.set("settleMs", String(input.settleMs));
    }
    return this.request(`/bridge/assets-search?${params.toString()}`, { method: "GET" });
  }

  async insertAssetFromPanel(input: {
    query: string;
    activateApp?: boolean;
    windowTitle?: string;
    resultIndex?: number;
    limit?: number;
    settleMs?: number;
    holdMs?: number;
    releaseMs?: number;
    dryRun?: boolean;
    syncSessionId?: string;
    syncWsUrl?: string;
    syncTimeoutMs?: number;
    postInsertDelayMs?: number;
  }): Promise<{
    query: string;
    resultIndex: number;
    dryRun: boolean;
    inserted: boolean;
    strategy?: "button" | "drag" | "dry-run";
    image?: string;
    window: Record<string, unknown>;
    match: Record<string, unknown>;
    from: Record<string, unknown>;
    to: Record<string, unknown>;
    sync?: Record<string, unknown>;
  }> {
    return this.request("/bridge/insert-asset", {
      method: "POST",
      body: input
    });
  }

  async instantiateComponent(input: {
    targetSessionId: string;
    sourceSessionId?: string;
    sourceFileKey?: string;
    query?: string;
    componentId?: string;
    componentKey?: string;
    parentId?: string;
    index?: number;
  }): Promise<{
    chosen: Record<string, unknown> | null;
    operationIds: string[];
    queued: FigmaOperationRecord[];
  }> {
    return this.request("/bridge/instantiate-component", {
      method: "POST",
      body: input
    });
  }

  async probeTalkToFigmaChannel(input: {
    channel: string;
    wsUrl?: string;
    timeoutMs?: number;
  }): Promise<{
    ok: true;
    wsUrl: string;
    channel: string;
    joinedAt: string;
  }> {
    return this.request("/bridge/talk-to-figma/probe", {
      method: "POST",
      body: input
    });
  }

  async listTalkToFigmaChannels(input: {
    logPath?: string;
    limit?: number;
  } = {}): Promise<{
    logPath: string;
    count: number;
    channels: Array<Record<string, unknown>>;
  }> {
    const params = new URLSearchParams();
    if (input.logPath) {
      params.set("logPath", input.logPath);
    }
    if (typeof input.limit === "number") {
      params.set("limit", String(input.limit));
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request(`/bridge/talk-to-figma/channels${suffix}`, { method: "GET" });
  }

  async discoverTalkToFigmaChannel(input: {
    wsUrl?: string;
    logPath?: string;
    limit?: number;
    timeoutMs?: number;
  } = {}): Promise<{
    channel: string;
    wsUrl: string;
    logPath: string;
    observed: Record<string, unknown>;
    probe: Record<string, unknown>;
    failedChannels: Array<Record<string, unknown>>;
  }> {
    return this.request("/bridge/talk-to-figma/discover", {
      method: "POST",
      body: input
    });
  }

  async listFigmaDevelopmentPlugins(input: {
    appName?: string;
  } = {}): Promise<{
    appName: string;
    plugins: string[];
  }> {
    const params = new URLSearchParams();
    if (input.appName) {
      params.set("appName", input.appName);
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request(`/bridge/figma/development-plugins${suffix}`, { method: "GET" });
  }

  async launchFigmaDevelopmentPlugin(input: {
    pluginName: string;
    appName?: string;
  }): Promise<{
    ok: true;
    appName: string;
    pluginName: string;
    launchedAt: string;
  }> {
    return this.request("/bridge/figma/launch-development-plugin", {
      method: "POST",
      body: input
    });
  }

  async launchAndDiscoverTalkToFigma(input: {
    pluginName: string;
    appName?: string;
    wsUrl?: string;
    logPath?: string;
    limit?: number;
    timeoutMs?: number;
    attempts?: number;
    delayMs?: number;
  }): Promise<{
    launch: Record<string, unknown>;
    discovered: Record<string, unknown>;
    attempts: number;
  }> {
    return this.request("/bridge/figma/launch-and-discover-talk-to-figma", {
      method: "POST",
      body: input
    });
  }

  async executeTalkToFigmaCommand(input: {
    channel: string;
    command: string;
    params?: Record<string, unknown>;
    wsUrl?: string;
    timeoutMs?: number;
  }): Promise<{
    ok: true;
    wsUrl: string;
    channel: string;
    joinedAt: string;
    requestId: string;
    command: string;
    result: unknown;
    progressUpdates: Array<Record<string, unknown>>;
  }> {
    return this.request("/bridge/talk-to-figma/command", {
      method: "POST",
      body: input
    });
  }

  async syncTalkToFigmaChannel(input: {
    channel: string;
    sessionId?: string;
    wsUrl?: string;
    timeoutMs?: number;
  }): Promise<{
    session: FigmaSession;
    snapshot: FigmaSnapshot;
  }> {
    return this.request("/bridge/talk-to-figma/sync", {
      method: "POST",
      body: input
    });
  }

  async ensureTalkToFigmaSession(input: {
    sessionId?: string;
    channel?: string;
    wsUrl?: string;
    logPath?: string;
    timeoutMs?: number;
    limit?: number;
    pluginName?: string;
    appName?: string;
    attempts?: number;
    delayMs?: number;
    forceLaunch?: boolean;
    staleThresholdMs?: number;
  }): Promise<{
    strategy: string;
    sessionHealth: "active" | "stale" | "unreachable" | "unknown";
    session: FigmaSession;
    snapshot: FigmaSnapshot;
    channel: string;
    wsUrl?: string;
    snapshotAge?: number;
    launch?: Record<string, unknown>;
    discovered?: Record<string, unknown>;
    attempts: Array<{
      strategy: string;
      ok: boolean;
      health: "active" | "stale" | "unreachable" | "unknown";
      sessionId?: string;
      channel?: string;
      error?: string;
      staleSince?: string;
      snapshotAge?: number;
    }>;
  }> {
    return this.request("/bridge/talk-to-figma/ensure-session", {
      method: "POST",
      body: input
    });
  }

  async executeTalkToFigmaQueue(input: {
    sessionId: string;
    limit?: number;
    wsUrl?: string;
    timeoutMs?: number;
    syncAfter?: boolean;
  }): Promise<{
    sessionId: string;
    channel: string;
    sessionHealth: "active" | "stale" | "unreachable" | "unknown";
    pulledCount: number;
    processedCount: number;
    updates: Array<Record<string, unknown>>;
    batches: Array<{
      batchId: string;
      status: "succeeded" | "partially_failed" | "fully_failed";
      failedOperationId?: string;
      failureMessage?: string;
      rollbackAttempted: boolean;
      rollbackSucceeded?: boolean;
      rollbackError?: string;
      succeededIds: string[];
      failedIds: string[];
      skippedIds: string[];
    }>;
    acknowledged: FigmaOperationRecord[];
    snapshotSynced: boolean;
  }> {
    return this.request("/bridge/talk-to-figma/run-queue", {
      method: "POST",
      body: input
    });
  }

  async materializeAsset(input: {
    query: string;
    sessionId?: string;
    channel?: string;
    wsUrl?: string;
    logPath?: string;
    timeoutMs?: number;
    limit?: number;
    pluginName?: string;
    appName?: string;
    attempts?: number;
    delayMs?: number;
    forceLaunch?: boolean;
    activateApp?: boolean;
    windowTitle?: string;
    resultIndex?: number;
    settleMs?: number;
    holdMs?: number;
    releaseMs?: number;
    dryRun?: boolean;
    postInsertDelayMs?: number;
    selectInsertedNodes?: boolean;
  }): Promise<{
    ensured: Record<string, unknown>;
    inserted: Record<string, unknown>;
    selectedNodeIds: string[];
    selectionRun?: Record<string, unknown>;
  }> {
    return this.request("/bridge/materialize-asset", {
      method: "POST",
      body: input
    });
  }

  async resolveBatch(sessionId: string, operations: FigmaBatchOperationInput[]): Promise<{
    resolvedOperations: FigmaOperationInput[];
    errors: Array<{ index: number; message: string }>;
    warnings: Array<{ index: number; message: string }>;
    notes: Array<{ index: number; message: string }>;
    resolutions: Array<Record<string, unknown>>;
  }> {
    return this.request("/bridge/resolve-batch", {
      method: "POST",
      body: { sessionId, operations }
    });
  }

  async enqueueBatch(input: {
    sessionId: string;
    clientRequestId?: string;
    description?: string;
    operations: FigmaBatchOperationInput[];
  }): Promise<{
    resolution: {
      resolvedOperations: FigmaOperationInput[];
      errors: Array<{ index: number; message: string }>;
      warnings: Array<{ index: number; message: string }>;
      notes: Array<{ index: number; message: string }>;
      resolutions: Array<Record<string, unknown>>;
    };
    operationIds: string[];
    queued: FigmaOperationRecord[];
  }> {
    return this.request("/bridge/enqueue-batch", {
      method: "POST",
      body: input
    });
  }

  // ─── Trace retrieval ──────────────────────────────────────────────────

  /**
   * Get recent traces, optionally filtered by flow type.
   *
   * Maps to `GET /bridge/traces?limit=N&flowType=...`
   */
  async getTraces(input: {
    limit?: number;
    flowType?: TraceFlowType;
  } = {}): Promise<{
    traces: TraceRecord[];
    count: number;
  }> {
    const params = new URLSearchParams();
    if (typeof input.limit === "number") {
      params.set("limit", String(input.limit));
    }
    if (input.flowType) {
      params.set("flowType", input.flowType);
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request(`/bridge/traces${suffix}`, { method: "GET" });
  }

  /**
   * Get a single trace record by ID.
   *
   * Maps to `GET /bridge/traces/:traceId`
   */
  async getTrace(traceId: string): Promise<TraceRecord> {
    return this.request(`/bridge/traces/${encodeURIComponent(traceId)}`, { method: "GET" });
  }

  /**
   * Get a trace and all its descendant traces (parent→child linkage).
   *
   * Maps to `GET /bridge/traces/:traceId/tree`
   */
  async getTraceTree(traceId: string): Promise<{
    traceId: string;
    tree: TraceRecord[];
    count: number;
  }> {
    return this.request(`/bridge/traces/${encodeURIComponent(traceId)}/tree`, { method: "GET" });
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private async request<T>(path: string, init: { method: string; body?: unknown }): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: init.method,
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(init.body ? { "content-type": "application/json" } : {})
      },
      body: init.body ? JSON.stringify(init.body) : undefined
    });

    const payload = (await response.json()) as T | { error?: string };
    if (!response.ok) {
      const error = typeof payload === "object" && payload && "error" in payload ? payload.error : undefined;
      throw new Error(error ? String(error) : `HTTP ${response.status}`);
    }

    return payload as T;
  }
}
