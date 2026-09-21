import type {
  ClusterView,
  MinimizerState,
  ReplayRecipe,
  ReplayResult,
  StoredRun,
  RuleVersion,
} from "../core/types.js";

export interface Snapshot {
  runs: StoredRun[];
  clusters: ClusterView[];
  ruleVersions: RuleVersion[];
  recipes: Record<string, ReplayRecipe>;
  minimizers: Record<string, MinimizerState & { currentMinimalRecipe: ReplayRecipe | null }>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    const err = body as { error?: string; details?: string[] };
    throw new Error([err.error ?? `HTTP ${response.status}`, ...(err.details ?? [])].join("\n"));
  }
  return body as T;
}

export const api = {
  state: () => request<Snapshot>("/api/state"),
  importNdjson: (ndjson: string) =>
    request<{ imported: string[]; duplicates: number; errors: { line: number; error: string }[]; state: Snapshot }>(
      "/api/import",
      { method: "POST", body: JSON.stringify({ ndjson }) },
    ),
  createRecipe: (fingerprint: string) =>
    request<{ recipe: ReplayRecipe; state: Snapshot }>("/api/recipes", {
      method: "POST",
      body: JSON.stringify({ fingerprint }),
    }),
  putRecipe: (recipe: ReplayRecipe) =>
    request<{ recipe: ReplayRecipe; state: Snapshot }>(`/api/recipes/${encodeURIComponent(recipe.id)}`, {
      method: "PUT",
      body: JSON.stringify(recipe),
    }),
  replay: (recipeId: string) =>
    request<{ result: ReplayResult }>(`/api/recipes/${encodeURIComponent(recipeId)}/replay`, {
      method: "POST",
      body: "{}",
    }),
  minimize: (recipeId: string, budget: number, ruleVersion: RuleVersion) =>
    request<{ minimizer: MinimizerState; state: Snapshot }>(
      `/api/recipes/${encodeURIComponent(recipeId)}/minimize`,
      { method: "POST", body: JSON.stringify({ budget, ruleVersion }) },
    ),
  advance: (minimizerId: string, steps: number) =>
    request<{ minimizer: MinimizerState; state: Snapshot }>(
      `/api/minimizers/${encodeURIComponent(minimizerId)}/advance`,
      { method: "POST", body: JSON.stringify({ steps }) },
    ),
};
