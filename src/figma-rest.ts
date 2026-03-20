type FigmaRestSearchOptions = {
  fileKey: string;
  query?: string;
  limit?: number;
  includeComponentSets?: boolean;
  token?: string;
  fetchFn?: typeof fetch;
};

type FigmaRestMetaComponent = {
  key: string;
  file_key: string;
  node_id: string;
  thumbnail_url?: string;
  name: string;
  description?: string;
  containing_frame?: {
    node_id?: string;
    page_id?: string;
    page_name?: string;
  };
};

type FigmaRestComponentsResponse = {
  meta?: {
    components?: FigmaRestMetaComponent[];
  };
};

type FigmaRestComponentSetsResponse = {
  meta?: {
    component_sets?: FigmaRestMetaComponent[];
  };
};

export type FigmaPublishedComponentResult = {
  source: "rest";
  kind: "component" | "component_set";
  key: string;
  fileKey: string;
  nodeId: string;
  name: string;
  description?: string;
  pageId?: string;
  pageName?: string;
  containingFrameNodeId?: string;
  thumbnailUrl?: string;
};

function resolveToken(explicitToken?: string): string | undefined {
  return explicitToken
    ?? process.env.FIGMA_ACCESS_TOKEN
    ?? process.env.FIGMA_TOKEN
    ?? process.env.FIGMA_PAT;
}

function normalizeQuery(query?: string): string | undefined {
  const normalized = query?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function filterAndRank<T extends FigmaPublishedComponentResult>(items: T[], query?: string, limit = 50): T[] {
  const normalizedQuery = normalizeQuery(query);
  const ranked = items
    .map((item) => {
      let score = 1;
      if (normalizedQuery) {
        const name = item.name.toLowerCase();
        const description = item.description?.toLowerCase() ?? "";
        if (name === normalizedQuery) {
          score += 100;
        } else if (name.startsWith(normalizedQuery)) {
          score += 60;
        } else if (name.includes(normalizedQuery)) {
          score += 25;
        } else if (description.includes(normalizedQuery)) {
          score += 10;
        } else {
          score = -1;
        }
      }
      return { item, score };
    })
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score || left.item.name.localeCompare(right.item.name));

  return ranked.slice(0, limit).map((entry) => entry.item);
}

async function requestJson<T>(path: string, options: {
  token?: string;
  fetchFn?: typeof fetch;
}): Promise<T> {
  const token = resolveToken(options.token);
  if (!token) {
    throw new Error("Figma REST search requires FIGMA_ACCESS_TOKEN, FIGMA_TOKEN, or FIGMA_PAT");
  }

  const fetchFn = options.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("fetch is unavailable in the current runtime");
  }

  const response = await fetchFn(`https://api.figma.com${path}`, {
    headers: {
      "x-figma-token": token
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Figma REST ${path} failed with ${response.status}: ${body}`);
  }

  return response.json() as Promise<T>;
}

export async function searchPublishedComponentsInFile(options: FigmaRestSearchOptions): Promise<FigmaPublishedComponentResult[]> {
  const fileKey = options.fileKey.trim();
  const includeComponentSets = options.includeComponentSets !== false;

  const [componentsPayload, componentSetsPayload] = await Promise.all([
    requestJson<FigmaRestComponentsResponse>(`/v1/files/${encodeURIComponent(fileKey)}/components`, options),
    includeComponentSets
      ? requestJson<FigmaRestComponentSetsResponse>(`/v1/files/${encodeURIComponent(fileKey)}/component_sets`, options)
      : Promise.resolve({ meta: { component_sets: [] } } as FigmaRestComponentSetsResponse)
  ]);

  const results: FigmaPublishedComponentResult[] = [
    ...(componentsPayload.meta?.components ?? []).map((component) => ({
      source: "rest" as const,
      kind: "component" as const,
      key: component.key,
      fileKey: component.file_key,
      nodeId: component.node_id,
      name: component.name,
      description: component.description,
      pageId: component.containing_frame?.page_id,
      pageName: component.containing_frame?.page_name,
      containingFrameNodeId: component.containing_frame?.node_id,
      thumbnailUrl: component.thumbnail_url
    })),
    ...(componentSetsPayload.meta?.component_sets ?? []).map((componentSet) => ({
      source: "rest" as const,
      kind: "component_set" as const,
      key: componentSet.key,
      fileKey: componentSet.file_key,
      nodeId: componentSet.node_id,
      name: componentSet.name,
      description: componentSet.description,
      pageId: componentSet.containing_frame?.page_id,
      pageName: componentSet.containing_frame?.page_name,
      containingFrameNodeId: componentSet.containing_frame?.node_id,
      thumbnailUrl: componentSet.thumbnail_url
    }))
  ];

  return filterAndRank(results, options.query, options.limit ?? 50);
}
