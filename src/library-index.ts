/**
 * Library Index — deterministic component discovery and import strategy ranking.
 *
 * This module introduces a cached, searchable index of discoverable library
 * components so that:
 * 1. asset discovery results are reusable across follow-up import attempts
 * 2. import attempts clearly report which strategy was used
 * 3. import reports distinguish runtime import, published-key import, and desktop fallback
 * 4. the implementation reduces hidden OCR dependence instead of increasing it
 */

import type { FigmaComponentSummary } from "./schemas.js";
import type { FigmaPublishedComponentResult } from "./figma-rest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ImportStrategy = "runtime" | "published-key" | "desktop-panel" | "none";

export type LibraryIndexEntry = {
  /** The component key (published key for cross-file import). */
  key?: string;
  /** The local component id within the source file. */
  componentId?: string;
  /** The component name as seen in the library. */
  name: string;
  /** Where the entry was discovered. */
  source: "live-session" | "rest-api" | "desktop-panel";
  /** The session id that provided this entry (if from a live session). */
  sourceSessionId?: string;
  /** The file key this component belongs to. */
  fileKey?: string;
  /** The node id within the source file. */
  nodeId?: string;
  /** Whether this is a component or a component set. */
  kind: "component" | "component_set";
  /** Optional description from the library. */
  description?: string;
  /** Optional page name the component lives on. */
  pageName?: string;
  /** ISO timestamp when this entry was added or refreshed. */
  discoveredAt: string;
};

export type ImportAttempt = {
  strategy: ImportStrategy;
  success: boolean;
  error?: string;
  durationMs: number;
};

export type ImportReport = {
  /** Which strategy actually succeeded (or "none" if all failed). */
  strategyUsed: ImportStrategy;
  /** Ordered list of all attempts. */
  attempts: ImportAttempt[];
  /** Whether the library index had a matching entry for the query. */
  indexHit: boolean;
  /** The component key used for the import, if resolved. */
  componentKey?: string;
  /** The component id used for the import, if resolved. */
  componentId?: string;
};

// ---------------------------------------------------------------------------
// Serialized shape (for persistence in bridge state)
// ---------------------------------------------------------------------------

export type LibraryIndexData = {
  entries: Record<string, LibraryIndexEntry>;
};

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

function entryMatchKey(entry: LibraryIndexEntry): string {
  return entry.key ?? `${entry.sourceSessionId ?? "unknown"}:${entry.componentId ?? entry.nodeId ?? entry.name}`;
}

// ---------------------------------------------------------------------------
// LibraryIndex
// ---------------------------------------------------------------------------

export class LibraryIndex {
  private entries = new Map<string, LibraryIndexEntry>();

  /**
   * Populate entries from live session component snapshots.
   */
  addFromLiveSession(sessionId: string, components: FigmaComponentSummary[], fileKey?: string): void {
    const now = new Date().toISOString();
    for (const component of components) {
      const entry: LibraryIndexEntry = {
        key: component.key,
        componentId: component.id,
        name: component.name,
        source: "live-session",
        sourceSessionId: sessionId,
        fileKey,
        nodeId: component.nodeId ?? component.id,
        // Live-session snapshots enumerate individual components (including
        // variants within a set).  component_set entries only come from the
        // REST API where `kind` is explicitly reported.
        kind: "component",
        description: component.description,
        pageName: component.pageName,
        discoveredAt: now,
      };
      this.entries.set(entryMatchKey(entry), entry);
    }
  }

  /**
   * Populate entries from Figma REST API published component results.
   */
  addFromRest(results: FigmaPublishedComponentResult[]): void {
    const now = new Date().toISOString();
    for (const result of results) {
      const entry: LibraryIndexEntry = {
        key: result.key,
        name: result.name,
        source: "rest-api",
        fileKey: result.fileKey,
        nodeId: result.nodeId,
        kind: result.kind,
        description: result.description,
        pageName: result.pageName,
        discoveredAt: now,
      };
      this.entries.set(entryMatchKey(entry), entry);
    }
  }

  /**
   * Search the index for components matching the query.
   * Results are ranked: exact match > starts-with > contains.
   */
  search(query: string, limit = 50): LibraryIndexEntry[] {
    const normalized = normalizeSearchQuery(query);
    if (!normalized) {
      return [...this.entries.values()].slice(0, limit);
    }

    const scored = [...this.entries.values()]
      .map((entry) => {
        const name = entry.name.toLowerCase();
        const desc = entry.description?.toLowerCase() ?? "";
        let score = 0;

        if (name === normalized) {
          score = 100;
        } else if (name.startsWith(normalized)) {
          score = 60;
        } else if (name.includes(normalized)) {
          score = 25;
        } else if (desc.includes(normalized)) {
          score = 10;
        } else {
          return null;
        }

        // Boost entries that have a published key (more deterministic).
        if (entry.key) {
          score += 20;
        }

        return { entry, score };
      })
      .filter((item): item is { entry: LibraryIndexEntry; score: number } => item !== null)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));

    return scored.slice(0, limit).map((item) => item.entry);
  }

  /**
   * Look up a specific entry by its component key.
   */
  getByKey(key: string): LibraryIndexEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.key === key) {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Rank import strategies for a given entry and target session.
   *
   * The order of preference is:
   * 1. "runtime" — the component is in the same session, use local componentId
   * 2. "published-key" — a component key exists, use importComponentByKeyAsync
   *    (only for kind === "component"; component_set is excluded because the
   *    Figma adapters only call importComponentByKeyAsync, not the component-set
   *    equivalent — see talk-to-figma-adapter.ts and figma-adapter.ts)
   * 3. "desktop-panel" — fall back to desktop OCR/drag insertion
   */
  rankStrategies(entry: LibraryIndexEntry, targetSessionId: string): ImportStrategy[] {
    const strategies: ImportStrategy[] = [];

    // If the component lives in the target session, direct runtime creation is possible.
    // component_set entries cannot be instantiated directly via create_instance.
    if (entry.sourceSessionId === targetSessionId && entry.componentId && entry.kind === "component") {
      strategies.push("runtime");
    }

    // If a published key exists, cross-file import is possible.
    // component_set entries are excluded because the adapters only call
    // importComponentByKeyAsync which expects a component key, not a set key.
    if (entry.key && entry.kind === "component") {
      strategies.push("published-key");
    }

    // Desktop panel insertion is always a last-resort fallback.
    strategies.push("desktop-panel");

    return strategies;
  }

  /** Total number of entries. */
  get size(): number {
    return this.entries.size;
  }

  /** Serialize to a plain object for persistence. */
  toJSON(): LibraryIndexData {
    const entries: Record<string, LibraryIndexEntry> = {};
    for (const [key, entry] of this.entries) {
      entries[key] = entry;
    }
    return { entries };
  }

  /** Restore from a plain object. */
  static fromJSON(data: LibraryIndexData | undefined): LibraryIndex {
    const index = new LibraryIndex();
    if (!data?.entries) {
      return index;
    }
    for (const [key, entry] of Object.entries(data.entries)) {
      index.entries.set(key, entry);
    }
    return index;
  }
}

// ---------------------------------------------------------------------------
// Import reporting helpers
// ---------------------------------------------------------------------------

export function createEmptyImportReport(): ImportReport {
  return {
    strategyUsed: "none",
    attempts: [],
    indexHit: false,
  };
}

export function recordAttempt(
  report: ImportReport,
  strategy: ImportStrategy,
  success: boolean,
  durationMs: number,
  error?: string,
): void {
  report.attempts.push({ strategy, success, error, durationMs });
  if (success && report.strategyUsed === "none") {
    report.strategyUsed = strategy;
  }
}
