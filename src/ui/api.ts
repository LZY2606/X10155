import type {
  Cluster,
  FailureSignature,
  MinimizeSession,
  ReplayRecipe,
  ReplayResult,
  RuleVersion,
  TestRun,
} from "../core/types";
import type { DiffToken } from "../core/cluster";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as T) : ({} as T);
  if (!response.ok) {
    throw new Error(
      (body as { error?: string }).error ?? `HTTP ${response.status}`,
    );
  }
  return body;
}

export interface StateResponse {
  runs: TestRun[];
  clusters: Cluster[];
  recipes: ReplayRecipe[];
  sessions: MinimizeSession[];
  ruleVersions: RuleVersion[];
  activeRuleVersion: RuleVersion;
}

export interface CompareResponse {
  a: FailureSignature;
  b: FailureSignature;
  tokens: DiffToken[];
}

export interface StepResponse {
  session: MinimizeSession;
  recipe: ReplayRecipe;
  attempt: { outcome: ReplayResult["outcome"]; accepted: boolean } | null;
}

export const api = {
  state: (version?: RuleVersion) =>
    request<StateResponse>(
      `/api/state${version ? `?version=${version}` : ""}`,
    ),
  importNdjson: (ndjson: string, recompute = false) =>
    request<{ imported: number; skipped: number; errors: string[] }>(
      "/api/import",
      {
        method: "POST",
        body: JSON.stringify({ ndjson, recomputeFingerprint: recompute }),
      },
    ),
  exportUrl: () => "/api/export",
  compare: (a: string, b: string) =>
    request<CompareResponse>("/api/compare", {
      method: "POST",
      body: JSON.stringify({ a, b }),
    }),
  createRecipe: (runId: string) =>
    request<ReplayRecipe>("/api/recipes", {
      method: "POST",
      body: JSON.stringify({ runId }),
    }),
  listRecipes: () =>
    request<{ recipes: ReplayRecipe[] }>("/api/recipes"),
  saveRecipe: (recipe: ReplayRecipe) =>
    request<ReplayRecipe>(`/api/recipes/${recipe.id}`, {
      method: "PUT",
      body: JSON.stringify(recipe),
    }),
  deleteRecipe: (id: string) =>
    request<{ ok: boolean }>(`/api/recipes/${id}`, { method: "DELETE" }),
  replay: (id: string) =>
    request<ReplayResult>(`/api/recipes/${id}/replay`, { method: "POST" }),
  minimize: (id: string, budget: number) =>
    request<{ session: MinimizeSession; recipe: ReplayRecipe }>(
      `/api/recipes/${id}/minimize`,
      { method: "POST", body: JSON.stringify({ budget }) },
    ),
  minimizeStep: (sessionId: string) =>
    request<StepResponse>(`/api/minimize/${sessionId}/step`, {
      method: "POST",
    }),
  setRuleVersion: (version: RuleVersion) =>
    request<{ activeRuleVersion: RuleVersion }>("/api/rule-version", {
      method: "POST",
      body: JSON.stringify({ version }),
    }),
  reset: () => request<{ ok: boolean }>("/api/reset", { method: "POST" }),
};
