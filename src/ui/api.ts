import type {
  ClusterView,
  ExportBundle,
  ImportReport,
  MinimizeSession,
  NoisePolicy,
  ReplayRecipe,
  ReplayResult,
  RunRecord,
} from '../core/types';

export interface VaultState {
  runs: RunRecord[];
  recipes: ReplayRecipe[];
  noisePolicy: NoisePolicy;
  activePackVersion: number;
  fingerprints: Record<string, string>;
  clusterViews: ClusterView[];
  registeredTests: string[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return payload as T;
}

export const api = {
  state: () => request<VaultState>('/api/state'),
  importNDJSON: (text: string) =>
    request<{ report: ImportReport }>('/api/import', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  loadSample: () =>
    request<{ report: ImportReport }>('/api/load-sample', { method: 'POST', body: '{}' }),
  reset: () => request<{ ok: boolean }>('/api/reset', { method: 'POST', body: '{}' }),
  setPolicy: (patch: { tempRoots?: string[]; packVersion?: number }) =>
    request<{ policy: NoisePolicy }>('/api/policy', {
      method: 'POST',
      body: JSON.stringify(patch),
    }),
  createRecipe: (runId: string) =>
    request<{ recipe: ReplayRecipe }>('/api/recipes', {
      method: 'POST',
      body: JSON.stringify({ runId }),
    }),
  updateRecipe: (
    id: string,
    edits: { seed?: number; env?: Record<string, string>; schedule?: RunRecord['schedule'] },
  ) =>
    request<{ recipe: ReplayRecipe }>('/api/recipes', {
      method: 'PUT',
      body: JSON.stringify({ id, ...edits }),
    }),
  replay: (recipeId: string) =>
    request<{ result: ReplayResult }>('/api/replay', {
      method: 'POST',
      body: JSON.stringify({ recipeId }),
    }),
  minimizeStart: (recipeId: string, budget: number) =>
    request<{ session: MinimizeSession }>('/api/minimize/start', {
      method: 'POST',
      body: JSON.stringify({ recipeId, budget }),
    }),
  minimizeStep: (sessionId: string) =>
    request<{ session: MinimizeSession }>('/api/minimize/step', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    }),
  minimizeRun: (sessionId: string) =>
    request<{ session: MinimizeSession }>('/api/minimize/run', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    }),
  exportUrl: '/api/export',
  downloadExport: async (): Promise<ExportBundle> => {
    const response = await fetch('/api/export');
    return (await response.json()) as ExportBundle;
  },
};
