/**
 * 框架无关的 HTTP API 处理器：Vite 开发中间件与测试共用同一实现。
 *
 * 所有“重放”只允许命中随项目提交的假执行器；路径逃逸、越权环境键、
 * 未知测试 / 未知调度点一律 422 拒绝，绝不启动任何外部进程。
 */
import {
  ExecutorBoundaryError,
  FAKE_TESTS,
  recipeId,
  validateRecipeRequest,
} from '../core/fakeExecutor.js';
import { parseNdjson, exportNdjson } from '../core/io.js';
import {
  DEFAULT_BUDGET,
  initMinimization,
  runMinimization,
} from '../core/minimizer.js';
import { LATEST_RULESET_VERSION, ALL_RULES } from '../core/normalizer.js';
import { buildRecipeFromRun, RecipeBuildError, replayWithRecipe } from '../core/recipe.js';
import { signatureForRun } from '../core/signature.js';
import { Store } from '../core/store.js';
import type {
  MinimizationState,
  ReplayRecipe,
} from '../core/types.js';

export interface ApiRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export function createApiHandler(store: Store) {
  return function handle(request: ApiRequest): ApiResponse {
    const { method, path } = request;

    if (method === 'GET' && path === '/api/state') {
      return ok(statePayload(store));
    }

    if (method === 'POST' && path === '/api/import') {
      const { text } = (request.body ?? {}) as { text?: string };
      if (typeof text !== 'string') {
        return badRequest('需要 { text: string }（NDJSON）');
      }
      const parsed = parseNdjson(text);
      if (parsed.issues.length > 0) {
        return badRequest('NDJSON 存在非法行，整批拒绝', { issues: parsed.issues });
      }
      let imported: string[];
      try {
        imported = store.importRuns(parsed.runs as Array<Parameters<Store['importRuns']>[0][number]>);
      } catch (error) {
        return badRequest((error as Error).message);
      }
      return ok({ imported, state: statePayload(store) });
    }

    if (method === 'GET' && path === '/api/export') {
      const listed = store.listRuns();
      return {
        status: 200,
        body: exportNdjson(
          listed.map((entry) => entry.run),
          listed.map((entry) => entry.fingerprint),
        ),
      };
    }

    if (method === 'POST' && path === '/api/recipes') {
      const { fingerprint } = (request.body ?? {}) as { fingerprint?: string };
      const run = fingerprint ? store.getRun(fingerprint) : undefined;
      if (!fingerprint || !run) {
        return notFound('找不到该运行指纹');
      }
      try {
        const recipe = buildRecipeFromRun(run, fingerprint, LATEST_RULESET_VERSION);
        store.saveRecipe(recipe);
        return ok({ recipe, state: statePayload(store) });
      } catch (error) {
        if (error instanceof RecipeBuildError) {
          return badRequest(error.message);
        }
        throw error;
      }
    }

    if (method === 'PUT' && path.startsWith('/api/recipes/')) {
      const id = path.slice('/api/recipes/'.length);
      const existing = store.getRecipe(id);
      if (!existing) {
        return notFound('配方不存在');
      }
      const body = (request.body ?? {}) as Partial<ReplayRecipe>;
      const env = sanitizeEnv(body.env ?? existing.env);
      const schedule = Array.isArray(body.schedule) ? body.schedule : existing.schedule;
      const seed = typeof body.seed === 'string' ? body.seed : existing.seed;
      try {
        // 编辑后的配方必须重新通过执行器边界校验（含路径逃逸与越权键）。
        validateRecipeRequest(existing.fakeTest, env, schedule);
        const reSaved: ReplayRecipe = {
          ...existing,
          seed,
          env,
          schedule,
          id: recipeId({ ...existing, seed, env, schedule }),
        };
        store.saveRecipe(reSaved);
        return ok({ recipe: reSaved, state: statePayload(store) });
      } catch (error) {
        return boundaryOrBadRequest(error);
      }
    }

    if (method === 'POST' && path.startsWith('/api/recipes/') && path.endsWith('/replay')) {
      const id = decodeURIComponent(path.slice('/api/recipes/'.length, -'/replay'.length));
      const recipe = store.getRecipe(id);
      if (!recipe) {
        return notFound('配方不存在');
      }
      try {
        const outcome = replayWithRecipe(recipe);
        return ok({ outcome });
      } catch (error) {
        return boundaryOrBadRequest(error);
      }
    }

    if (method === 'POST' && path.startsWith('/api/recipes/') && path.endsWith('/minimize')) {
      const id = decodeURIComponent(path.slice('/api/recipes/'.length, -'/minimize'.length));
      const recipe = store.getRecipe(id);
      if (!recipe) {
        return notFound('配方不存在');
      }
      const body = (request.body ?? {}) as { budget?: number; continueId?: string; steps?: number };
      try {
        let state: MinimizationState;
        if (body.continueId) {
          const previous = store.getMinimization(body.continueId);
          if (!previous || previous.recipeId !== recipe.id) {
            return notFound('找不到可继续的最小化实验');
          }
          state = previous;
        } else {
          const budget = clampBudget(body.budget ?? DEFAULT_BUDGET);
          state = initMinimization(recipe, budget);
        }
        const steps = clampSteps(body.steps ?? 1);
        state = runMinimization(state, steps);
        store.saveRecipe(state.currentRecipe);
        store.saveMinimization(state);
        return ok({ minimization: state, recipe: state.currentRecipe, state: statePayload(store) });
      } catch (error) {
        return boundaryOrBadRequest(error);
      }
    }

    if (method === 'POST' && path === '/api/compare') {
      const { a, b, rulesetVersion } = (request.body ?? {}) as {
        a?: string;
        b?: string;
        rulesetVersion?: number;
      };
      const runA = a ? store.getRun(a) : undefined;
      const runB = b ? store.getRun(b) : undefined;
      if (!runA || !runB) {
        return badRequest('需要两条运行的指纹 a / b');
      }
      const version = rulesetVersion === 1 || rulesetVersion === LATEST_RULESET_VERSION
        ? rulesetVersion
        : LATEST_RULESET_VERSION;
      return ok({
        a: { fingerprint: a, run: runA, signature: signatureForRun(runA, version) },
        b: { fingerprint: b, run: runB, signature: signatureForRun(runB, version) },
      });
    }

    return { status: 404, body: { error: '未知的 API 路径' } };
  };
}

function sanitizeEnv(env: unknown): Record<string, string> {
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    throw new ExecutorBoundaryError('env 必须是字符串到字符串的对象');
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new ExecutorBoundaryError(`环境变量 ${key} 的值必须是字符串`);
    }
    out[key] = value;
  }
  return out;
}

function clampBudget(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new ExecutorBoundaryError('budget 必须是 >= 1 的整数');
  }
  return Math.min(value, 200);
}

function clampSteps(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new ExecutorBoundaryError('steps 必须是 >= 1 的整数');
  }
  return Math.min(value, 200);
}

function boundaryOrBadRequest(error: unknown): ApiResponse {
  if (error instanceof ExecutorBoundaryError || error instanceof RecipeBuildError) {
    return { status: 422, body: { error: error.message } };
  }
  throw error;
}

function statePayload(store: Store) {
  return {
    rulesetVersion: LATEST_RULESET_VERSION,
    rules: ALL_RULES,
    runs: store.listRuns(),
    clusterViews: store.allClusterViews(),
    recipes: store.listRecipes(),
    minimizations: Object.values(store.state.minimizations),
    fakeTests: Object.values(FAKE_TESTS),
  };
}

function ok(body: unknown): ApiResponse {
  return { status: 200, body };
}

function badRequest(error: string, extra?: Record<string, unknown>): ApiResponse {
  return { status: 400, body: { error, ...extra } };
}

function notFound(error: string): ApiResponse {
  return { status: 404, body: { error } };
}
