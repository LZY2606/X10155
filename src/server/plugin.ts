import type { Plugin, ViteDevServer } from 'vite';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAllViews } from '../core/cluster';
import { runFingerprint } from '../core/fingerprint';
import {
  createMinimizeSession,
  runMinimizeToEnd,
  stepMinimizeSession,
  type InternalMinimizeSession,
} from '../core/minimize';
import { replayRecipe } from '../core/replay';
import {
  isRegisteredTest,
  registeredTestIds,
} from '../core/executor';
import { makeExportBundle } from '../core/ndjson';
import { listRulePacks } from '../core/rulePacks';
import {
  RecipeValidationError,
  validateRecipeShape,
  withRecipeEdits,
} from '../core/recipe';
import type { NoisePolicy, ReplayRecipe } from '../core/types';
import { VaultStore } from './store';

/**
 * 服务端 API 边界：
 * - 浏览器只提供 JSON 参数，不存在任何命令/路径形式的执行请求；
 * - testId 必须命中随项目提交的假执行器注册表；
 * - 配方字段全部经 validateRecipeShape 白名单校验，拒绝路径逃逸与参数夹带。
 */
export function replayApiPlugin(): Plugin {
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = resolve(here, '../../.vault-data');
  const store = new VaultStore(dataDir);
  const sessions = new Map<string, InternalMinimizeSession>();

  return {
    name: 'flaky-replay-api',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api', async (req, res) => {
        try {
          await handle(req, res);
        } catch (error) {
          sendJson(res, 500, { error: (error as Error).message });
        }
      });

      async function handle(req: { url?: string; method?: string }, res: any): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const route = `${(req.method ?? 'GET').toUpperCase()} ${url.pathname}`;

        if (route === 'GET /state') {
          const state = store.snapshot();
          const policies = listRulePacks().map((pack) =>
            store.policyForPack(pack.packVersion),
          );
          return sendJson(res, 200, {
            ...state,
            fingerprints: Object.fromEntries(
              state.runs.map((run) => [run.id, runFingerprint(run)]),
            ),
            clusterViews: buildAllViews(state.runs, policies),
            registeredTests: registeredTestIds(),
          });
        }

        if (route === 'POST /import') {
          const body = await readBody(req);
          const report = store.importNDJSON(String(body.text ?? ''));
          return sendJson(res, 200, { report });
        }

        if (route === 'POST /load-sample') {
          const samplePath = resolve(here, '../../public/data/sample-runs.ndjson');
          const report = store.importNDJSON(readFileSync(samplePath, 'utf8'));
          return sendJson(res, 200, { report });
        }

        if (route === 'POST /policy') {
          const body = await readBody(req);
          const policy = store.setPolicy({
            tempRoots: Array.isArray(body.tempRoots)
              ? (body.tempRoots as unknown[])
              : undefined,
            packVersion:
              typeof body.packVersion === 'number' ? body.packVersion : undefined,
          });
          return sendJson(res, 200, { policy });
        }

        if (route === 'POST /recipes') {
          const body = await readBody(req);
          if (typeof body.runId !== 'string') {
            return sendJson(res, 400, { error: '缺少 runId' });
          }
          const recipe = store.createRecipe(body.runId);
          return sendJson(res, 200, { recipe });
        }

        if (route === 'PUT /recipes') {
          const body = await readBody(req);
          const existing =
            typeof body.id === 'string' ? store.getRecipe(body.id) : undefined;
          if (!existing) {
            return sendJson(res, 404, { error: '配方不存在' });
          }
          let seed = existing.seed;
          let env;
          let schedule;
          try {
            if (body.seed !== undefined || body.env !== undefined || body.schedule !== undefined) {
              const validated = validateRecipeShape({
                testId: existing.testId,
                seed: body.seed ?? existing.seed,
                env: body.env ?? existing.env,
                schedule: body.schedule ?? existing.schedule,
              });
              seed = validated.seed;
              env = validated.env;
              schedule = validated.schedule;
            }
          } catch (error) {
            const status = error instanceof RecipeValidationError ? 400 : 500;
            return sendJson(res, status, { error: (error as Error).message });
          }
          const updated = withRecipeEdits(existing, { seed, env, schedule });
          store.putRecipe(updated);
          return sendJson(res, 200, { recipe: updated });
        }

        if (route === 'POST /replay') {
          const body = await readBody(req);
          if (typeof body.recipeId !== 'string') {
            return sendJson(res, 400, { error: '缺少 recipeId' });
          }
          const recipe = store.getRecipe(body.recipeId);
          if (!recipe) {
            return sendJson(res, 404, { error: '配方不存在' });
          }
          return sendJson(res, 200, {
            result: replayRecipe(recipe, policyForRecipe(recipe, store)),
          });
        }

        if (route === 'POST /minimize/start') {
          const body = await readBody(req);
          if (typeof body.recipeId !== 'string') {
            return sendJson(res, 400, { error: '缺少 recipeId' });
          }
          const recipe = store.getRecipe(body.recipeId);
          if (!recipe) {
            return sendJson(res, 404, { error: '配方不存在' });
          }
          const budget =
            typeof body.budget === 'number' && Number.isInteger(body.budget)
              ? body.budget
              : 24;
          const session = createMinimizeSession(
            recipe,
            policyForRecipe(recipe, store),
            budget,
          );
          sessions.set(session.sessionId, session);
          return sendJson(res, 200, { session: publicSession(session) });
        }

        if (route === 'POST /minimize/step') {
          const body = await readBody(req);
          const session = sessions.get(String(body.sessionId ?? ''));
          if (!session) {
            return sendJson(res, 404, { error: '最小化会话不存在' });
          }
          stepMinimizeSession(session, policyForRecipe(session.currentRecipe, store));
          if (
            session.status === 'minimized' ||
            session.status === 'budget-exhausted'
          ) {
            store.putRecipe(session.currentRecipe);
          }
          return sendJson(res, 200, { session: publicSession(session) });
        }

        if (route === 'POST /minimize/run') {
          const body = await readBody(req);
          const session = sessions.get(String(body.sessionId ?? ''));
          if (!session) {
            return sendJson(res, 404, { error: '最小化会话不存在' });
          }
          let guard = 0;
          while (session.status === 'reproducing' && guard < 10000) {
            if (session.replaysUsed >= session.budget) {
              break;
            }
            stepMinimizeSession(session, policyForRecipe(session.currentRecipe, store));
            guard += 1;
          }
          store.putRecipe(session.currentRecipe);
          return sendJson(res, 200, { session: publicSession(session) });
        }

        if (route === 'GET /export') {
          const state = store.snapshot();
          const policies = listRulePacks().map((pack) =>
            store.policyForPack(pack.packVersion),
          );
          const bundle = makeExportBundle(
            state.runs,
            state.noisePolicy,
            state.recipes,
            buildAllViews(state.runs, policies),
          );
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.statusCode = 200;
          return res.end(JSON.stringify(bundle));
        }

        if (route === 'POST /reset') {
          sessions.clear();
          store.reset();
          return sendJson(res, 200, { ok: true });
        }

        return sendJson(res, 404, {
          error: `未知 API：${route}`,
          registeredTests: registeredTestIds(),
        });
      }
    },
  };
}

function policyForRecipe(recipe: ReplayRecipe, store: VaultStore): NoisePolicy {
  return store.policyForPack(recipe.targetPackVersion);
}

function publicSession(session: InternalMinimizeSession) {
  return {
    sessionId: session.sessionId,
    recipeId: session.recipeId,
    status: session.status,
    budget: session.budget,
    replaysUsed: session.replaysUsed,
    step: session.step,
    currentRecipe: session.currentRecipe,
    evidence: session.evidence,
  };
}

function sendJson(res: any, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function readBody(req: { on: Function }): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as any) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as Record<string, any>;
}

export { isRegisteredTest };
