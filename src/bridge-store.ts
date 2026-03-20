import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { TraceStore } from "./trace-store.js";

import {
  acknowledgeOperationsSchema,
  bridgeStateSchema,
  enqueueOperationsSchema,
  type FigmaComponentSummary,
  figmaSnapshotSchema,
  figmaSessionSchema,
  type BridgeState,
  type FigmaOperationRecord,
  type FigmaSnapshot,
  type FigmaSession
} from "./schemas.js";
import { LibraryIndex } from "./library-index.js";

function nowIso(): string {
  return new Date().toISOString();
}

function createEmptyState(): BridgeState {
  return bridgeStateSchema.parse({});
}

function getBatchKey(record: FigmaOperationRecord): string {
  return record.batchId ?? record.operationId;
}

type SearchComponentsOptions = {
  query?: string;
  sessionId?: string;
  limit?: number;
};

export type LiveComponentResult = {
  sessionId: string;
  fileKey?: string;
  fileName?: string;
  pageId?: string;
  pageName?: string;
  component: FigmaComponentSummary;
};

type ResolveComponentReferenceOptions = {
  targetSessionId: string;
  sourceSessionId?: string;
  query?: string;
  componentId?: string;
  componentKey?: string;
  limit?: number;
};

type ResolvedComponentReference = {
  chosen: LiveComponentResult | null;
  componentId?: string;
  componentKey?: string;
};

function rankComponentCandidate(candidate: LiveComponentResult, query: string, targetSessionId: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  const componentName = candidate.component.name.toLowerCase();
  let score = 0;

  if (componentName === normalizedQuery) {
    score += 100;
  } else if (componentName.startsWith(normalizedQuery)) {
    score += 60;
  } else if (componentName.includes(normalizedQuery)) {
    score += 25;
  }

  if (candidate.component.key) {
    score += 20;
  }
  if (candidate.sessionId === targetSessionId) {
    score += 10;
  }
  if (candidate.fileName?.toLowerCase().includes(normalizedQuery)) {
    score += 5;
  }

  return score;
}

function chooseComponentCandidate(options: {
  candidates: LiveComponentResult[];
  query: string;
  targetSessionId: string;
}): LiveComponentResult | null {
  const ranked = options.candidates
    .map((candidate) => ({
      candidate,
      score: rankComponentCandidate(candidate, options.query, options.targetSessionId)
    }))
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.candidate ?? null;
}

export class BridgeStore {
  private state: BridgeState = createEmptyState();
  private readonly statePath: string;
  private tracesPath: string;
  private initialized = false;
  private traceStore: TraceStore = new TraceStore();
  private libraryIndex: LibraryIndex = new LibraryIndex();

  constructor(statePath: string) {
    this.statePath = statePath;
    this.tracesPath = join(dirname(statePath), "traces.json");
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const raw = await readFile(this.statePath, "utf8");
      this.state = bridgeStateSchema.parse(JSON.parse(raw));
      this.libraryIndex = LibraryIndex.fromJSON(this.state.libraryIndex);
    } catch {
      this.state = createEmptyState();
      await this.persist();
    }

    this.traceStore = await TraceStore.loadFrom(this.tracesPath);

    this.initialized = true;
  }

  async registerSession(input: unknown): Promise<FigmaSession> {
    await this.init();
    const parsed = figmaSessionSchema.parse(input);
    const existing = this.state.sessions[parsed.sessionId];
    const timestamp = nowIso();
    const session: FigmaSession = {
      ...existing,
      ...parsed,
      connectedAt: existing?.connectedAt ?? parsed.connectedAt ?? timestamp,
      lastHeartbeatAt: timestamp
    };

    this.state.sessions[session.sessionId] = session;
    await this.persist();
    return session;
  }

  async upsertSnapshot(input: unknown): Promise<FigmaSnapshot> {
    await this.init();
    const parsed = figmaSnapshotSchema.parse(input);
    const snapshot: FigmaSnapshot = {
      ...parsed,
      capturedAt: parsed.capturedAt ?? nowIso()
    };

    this.state.snapshots[snapshot.sessionId] = snapshot;

    const existingSession = this.state.sessions[snapshot.sessionId];
    if (existingSession) {
      this.state.sessions[snapshot.sessionId] = {
        ...existingSession,
        fileKey: snapshot.fileKey ?? existingSession.fileKey,
        fileName: snapshot.fileName ?? existingSession.fileName,
        pageId: snapshot.pageId ?? existingSession.pageId,
        pageName: snapshot.pageName ?? existingSession.pageName,
        selectionIds: snapshot.selectionIds,
        lastHeartbeatAt: nowIso()
      };
    }

    // Auto-populate the library index with components from this snapshot.
    if (snapshot.components.length > 0) {
      this.libraryIndex.addFromLiveSession(
        snapshot.sessionId,
        snapshot.components,
        snapshot.fileKey ?? existingSession?.fileKey
      );
      this.state.libraryIndex = this.libraryIndex.toJSON();
    }

    await this.persist();
    return snapshot;
  }

  async enqueueOperations(input: unknown): Promise<FigmaOperationRecord[]> {
    await this.init();
    const parsed = enqueueOperationsSchema.parse(input);
    const timestamp = nowIso();
    const batchId = randomUUID();
    const created = parsed.operations.map((operation) => {
      const record: FigmaOperationRecord = {
        operationId: randomUUID(),
        batchId,
        sessionId: parsed.sessionId,
        clientRequestId: parsed.clientRequestId,
        description: parsed.description,
        status: "queued",
        operation,
        createdAt: timestamp,
        touchedNodeIds: []
      };
      this.state.operations[record.operationId] = record;
      return record;
    });

    await this.persist();
    return created;
  }

  async pullQueuedOperations(sessionId: string, limit = 20): Promise<FigmaOperationRecord[]> {
    await this.init();
    const queuedRecords = Object.values(this.state.operations)
      .filter((record) => record.sessionId === sessionId && record.status === "queued")
      .sort((left, right) => {
        const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
        if (createdAtComparison !== 0) {
          return createdAtComparison;
        }
        return left.operationId.localeCompare(right.operationId);
      });

    const selected: FigmaOperationRecord[] = [];
    let cursor = 0;

    while (cursor < queuedRecords.length) {
      const current = queuedRecords[cursor];
      if (!current) {
        break;
      }

      const batchKey = getBatchKey(current);
      const batchRecords: FigmaOperationRecord[] = [];

      while (cursor < queuedRecords.length && getBatchKey(queuedRecords[cursor]!) === batchKey) {
        batchRecords.push(queuedRecords[cursor]!);
        cursor += 1;
      }

      if (selected.length > 0 && selected.length + batchRecords.length > limit) {
        break;
      }

      selected.push(...batchRecords);

      if (selected.length >= limit) {
        break;
      }
    }

    const dispatchedAt = nowIso();
    const records = selected.map((record) => ({
      ...record,
      status: "dispatched" as const,
      dispatchedAt: record.dispatchedAt ?? dispatchedAt
    }));

    for (const record of records) {
      this.state.operations[record.operationId] = record;
    }

    if (records.length > 0) {
      await this.persist();
    }

    return records;
  }

  async acknowledgeOperations(input: unknown): Promise<FigmaOperationRecord[]> {
    await this.init();
    const parsed = acknowledgeOperationsSchema.parse(input);
    const completedAt = nowIso();
    const updated: FigmaOperationRecord[] = [];

    for (const update of parsed.updates) {
      const existing = this.state.operations[update.operationId];
      if (!existing) {
        throw new Error(`Unknown operationId: ${update.operationId}`);
      }

      if (existing.sessionId !== parsed.sessionId) {
        throw new Error(`Operation ${update.operationId} does not belong to session ${parsed.sessionId}`);
      }

      const nextRecord: FigmaOperationRecord = {
        ...existing,
        status: update.status,
        error: update.error,
        result: update.result,
        touchedNodeIds: update.touchedNodeIds,
        completedAt
      };

      this.state.operations[nextRecord.operationId] = nextRecord;
      updated.push(nextRecord);
    }

    await this.persist();
    return updated;
  }

  async getSnapshot(sessionId: string): Promise<FigmaSnapshot | null> {
    await this.init();
    return this.state.snapshots[sessionId] ?? null;
  }

  async getSession(sessionId: string): Promise<FigmaSession | null> {
    await this.init();
    return this.state.sessions[sessionId] ?? null;
  }

  async getStatus(sessionId?: string): Promise<{
    sessions: FigmaSession[];
    operations: FigmaOperationRecord[];
  }> {
    await this.init();
    const sessions = Object.values(this.state.sessions)
      .filter((session) => !sessionId || session.sessionId === sessionId)
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    const operations = Object.values(this.state.operations)
      .filter((record) => !sessionId || record.sessionId === sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return { sessions, operations };
  }

  async searchComponents(options: SearchComponentsOptions = {}): Promise<LiveComponentResult[]> {
    await this.init();
    const query = options.query?.trim().toLowerCase();
    const limit = options.limit ?? 50;
    const results: Array<LiveComponentResult & { score: number }> = [];

    for (const [sessionId, snapshot] of Object.entries(this.state.snapshots)) {
      if (options.sessionId && sessionId !== options.sessionId) {
        continue;
      }

      const session = this.state.sessions[sessionId];

      for (const component of snapshot.components) {
        const haystacks = [
          component.name,
          component.description,
          component.pageName,
          session?.fileName,
          snapshot.fileName
        ].filter((value): value is string => Boolean(value));

        let score = 1;
        if (query) {
          const matchIndex = haystacks.findIndex((value) => value.toLowerCase().includes(query));
          if (matchIndex === -1) {
            continue;
          }
          score = 10 - Math.min(matchIndex, 9);
          if (component.name.toLowerCase().startsWith(query)) {
            score += 5;
          }
        }

        results.push({
          sessionId,
          fileKey: snapshot.fileKey ?? session?.fileKey,
          fileName: snapshot.fileName ?? session?.fileName,
          pageId: component.pageId ?? snapshot.pageId ?? session?.pageId,
          pageName: component.pageName ?? snapshot.pageName ?? session?.pageName,
          component,
          score
        });
      }
    }

    return results
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        const fileCompare = (left.fileName ?? "").localeCompare(right.fileName ?? "");
        if (fileCompare !== 0) {
          return fileCompare;
        }
        return left.component.name.localeCompare(right.component.name);
      })
      .slice(0, limit)
      .map(({ score: _score, ...result }) => result);
  }

  async resolveComponentReference(options: ResolveComponentReferenceOptions): Promise<ResolvedComponentReference> {
    await this.init();

    if (options.componentId || options.componentKey) {
      return {
        chosen: null,
        componentId: options.componentId,
        componentKey: options.componentKey
      };
    }

    if (!options.query) {
      throw new Error("resolveComponentReference requires query, componentId, or componentKey");
    }

    const candidates = await this.searchComponents({
      query: options.query,
      sessionId: options.sourceSessionId,
      limit: options.limit ?? 100
    });
    const chosen = chooseComponentCandidate({
      candidates,
      query: options.query,
      targetSessionId: options.targetSessionId
    });

    if (!chosen) {
      return {
        chosen: null
      };
    }

    const canUseLocalId = chosen.sessionId === options.targetSessionId;
    return {
      chosen,
      componentId: canUseLocalId ? chosen.component.id : undefined,
      componentKey: chosen.component.key
    };
  }

  async getLibraryIndex(): Promise<LibraryIndex> {
    await this.init();
    return this.libraryIndex;
  }

  async getTraceStore(): Promise<TraceStore> {
    await this.init();
    return this.traceStore;
  }

  /** Persist trace store to its separate file. */
  async persistTraces(): Promise<void> {
    await this.traceStore.saveTo(this.tracesPath);
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, JSON.stringify(this.state, null, 2));
  }
}
