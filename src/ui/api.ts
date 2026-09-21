import type {
  ClusterView,
  MinimizationState,
  NormalizerRule,
  ReplayOutcome,
  ReplayRecipe,
  RunRecord,
} from '../core/types';

export interface FakeTestInfo {
  id: string;
  title: string;
  allowedEnvKeys: string[];
  requiredEnvKeys: string[];
  pathEnvKeys: string[];
  schedulePoints: Record<string, string[]>;
}

export interface StatePayload {
  rulesetVersion: number;
  rules: NormalizerRule[];
  runs: Array<{ fingerprint: string; run: RunRecord }>;
  clusterViews: ClusterView[];
  recipes: ReplayRecipe[];
  minimizations: MinimizationState[];
  fakeTests: FakeTestInfo[];
}

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `HTTP ${response.status}`);
  }
  return payload as T;
}

export const api = {
  state: () => request<StatePayload>('/api/state'),
  importNdjson: (text: string) =>
    request<{ imported: string[]; state: StatePayload }>('/api/import', { method: 'POST', body: { text } }),
  exportUrl: '/api/export',
  createRecipe: (fingerprint: string) =>
    request<{ recipe: ReplayRecipe; state: StatePayload }>('/api/recipes', {
      method: 'POST',
      body: { fingerprint },
    }),
  updateRecipe: (
    id: string,
    patch: { seed: string; env: Record<string, string>; schedule: ReplayRecipe['schedule'] },
  ) =>
    request<{ recipe: ReplayRecipe; state: StatePayload }>(`/api/recipes/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: patch,
    }),
  replay: (id: string) =>
    request<{ outcome: ReplayOutcome }>(`/api/recipes/${encodeURIComponent(id)}/replay`, {
      method: 'POST',
    }),
  minimize: (
    id: string,
    body: { budget?: number; continueId?: string; steps?: number },
  ) =>
    request<{ minimization: MinimizationState; recipe: ReplayRecipe; state: StatePayload }>(
      `/api/recipes/${encodeURIComponent(id)}/minimize`,
      { method: 'POST', body },
    ),
  compare: (a: string, b: string, rulesetVersion: number) =>
    request<CompareResponse>('/api/compare', { method: 'POST', body: { a, b, rulesetVersion } }),
};

export interface CompareResponse {
  a: { fingerprint: string; run: RunRecord; signature: { hash: string; canonical: string; traces: unknown[] } };
  b: { fingerprint: string; run: RunRecord; signature: { hash: string; canonical: string; traces: unknown[] } };
}
