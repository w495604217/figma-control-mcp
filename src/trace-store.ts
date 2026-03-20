/**
 * Structured trace store for control-flow observability.
 *
 * Captures structured records for key control flows (ensure-session,
 * queue-execution, materialize-asset) with parent-child linkage and
 * ring-buffer retention.
 */

import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Trace record
// ---------------------------------------------------------------------------

export type TraceFlowType =
  | "ensure-session"
  | "queue-execution"
  | "materialize-asset";

export type TraceStatus = "succeeded" | "failed";

export type TraceRecord = {
  /** Unique identifier for this trace. */
  traceId: string;
  /** Parent trace id for linked sub-operations. */
  parentTraceId?: string;
  /** Which control flow this trace represents. */
  flowType: TraceFlowType;
  /** ISO timestamp when the flow started. */
  startedAt: string;
  /** ISO timestamp when the flow completed. */
  completedAt: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Whether the flow succeeded or failed. */
  status: TraceStatus;
  /** Session id if available. */
  sessionId?: string;
  /** Channel name if available. */
  channel?: string;
  /** Sanitized input snapshot for replay/audit. */
  input: Record<string, unknown>;
  /** Structured result summary. */
  output: Record<string, unknown>;
  /** Non-fatal warnings from the flow. */
  warnings: string[];
  /** Error messages from the flow. */
  errors: string[];
};

// ---------------------------------------------------------------------------
// Trace store
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TRACES = 100;

export class TraceStore {
  private traces: TraceRecord[] = [];
  private readonly maxTraces: number;

  constructor(maxTraces = DEFAULT_MAX_TRACES) {
    this.maxTraces = maxTraces;
  }

  /** Generate a new trace id. */
  static newTraceId(): string {
    return randomUUID();
  }

  /** Add a trace record to the store (ring-buffer eviction). */
  addTrace(trace: TraceRecord): void {
    this.traces.push(trace);
    if (this.traces.length > this.maxTraces) {
      this.traces = this.traces.slice(this.traces.length - this.maxTraces);
    }
  }

  /** Get recent traces, newest first. */
  getRecentTraces(limit = 20): TraceRecord[] {
    return this.traces
      .slice()
      .reverse()
      .slice(0, limit);
  }

  /** Get a single trace by id. */
  getTrace(traceId: string): TraceRecord | null {
    return this.traces.find((t) => t.traceId === traceId) ?? null;
  }

  /** Get traces filtered by flow type, newest first. */
  getTracesByFlow(flowType: TraceFlowType, limit = 20): TraceRecord[] {
    return this.traces
      .filter((t) => t.flowType === flowType)
      .reverse()
      .slice(0, limit);
  }

  /**
   * Get a trace tree: the root trace + all descendant traces linked
   * via parentTraceId.
   */
  getTraceTree(traceId: string): TraceRecord[] {
    const root = this.getTrace(traceId);
    if (!root) {
      return [];
    }

    const result: TraceRecord[] = [root];
    const queue = [traceId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const children = this.traces.filter(
        (t) => t.parentTraceId === currentId
      );
      for (const child of children) {
        if (!result.some((r) => r.traceId === child.traceId)) {
          result.push(child);
          queue.push(child.traceId);
        }
      }
    }

    return result;
  }

  /** Total number of stored traces. */
  get size(): number {
    return this.traces.length;
  }

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  /** Serialize to JSON-safe object. */
  toJSON(): TraceRecord[] {
    return this.traces.slice();
  }

  /** Load from serialized data. */
  static fromJSON(data: unknown, maxTraces = DEFAULT_MAX_TRACES): TraceStore {
    const store = new TraceStore(maxTraces);
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item && typeof item === "object" && typeof item.traceId === "string") {
          store.traces.push(item as TraceRecord);
        }
      }
      // Trim to max on load
      if (store.traces.length > store.maxTraces) {
        store.traces = store.traces.slice(store.traces.length - store.maxTraces);
      }
    }
    return store;
  }

  // -------------------------------------------------------------------------
  // File persistence
  // -------------------------------------------------------------------------

  /** Save traces to a JSON file. */
  async saveTo(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(this.toJSON(), null, 2));
  }

  /** Load traces from a JSON file. */
  static async loadFrom(filePath: string, maxTraces = DEFAULT_MAX_TRACES): Promise<TraceStore> {
    try {
      const raw = await readFile(filePath, "utf8");
      return TraceStore.fromJSON(JSON.parse(raw), maxTraces);
    } catch {
      return new TraceStore(maxTraces);
    }
  }
}

// ---------------------------------------------------------------------------
// Trace builder helper
// ---------------------------------------------------------------------------

export type TraceContext = {
  traceStore: TraceStore;
  traceId: string;
  parentTraceId?: string;
};

/**
 * Create a trace context that can be passed to child flows.
 * If no traceStore is provided, returns undefined (tracing disabled).
 */
export function createTraceContext(
  traceStore: TraceStore | undefined,
  parentTraceId?: string
): TraceContext | undefined {
  if (!traceStore) {
    return undefined;
  }
  return {
    traceStore,
    traceId: TraceStore.newTraceId(),
    parentTraceId,
  };
}

/**
 * Record a completed trace. Computes durationMs from start time.
 */
export function recordTrace(
  context: TraceContext,
  options: {
    flowType: TraceFlowType;
    startedAt: string;
    status: TraceStatus;
    sessionId?: string;
    channel?: string;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
    warnings?: string[];
    errors?: string[];
  }
): TraceRecord {
  const completedAt = new Date().toISOString();
  const startTime = new Date(options.startedAt).getTime();
  const durationMs = Math.max(0, Date.now() - startTime);

  const trace: TraceRecord = {
    traceId: context.traceId,
    parentTraceId: context.parentTraceId,
    flowType: options.flowType,
    startedAt: options.startedAt,
    completedAt,
    durationMs,
    status: options.status,
    sessionId: options.sessionId,
    channel: options.channel,
    input: options.input,
    output: options.output,
    warnings: options.warnings ?? [],
    errors: options.errors ?? [],
  };

  context.traceStore.addTrace(trace);
  return trace;
}
