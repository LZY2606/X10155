import type { IncomingMessage, ServerResponse } from 'node:http';
import { clusterRuns } from '../core/cluster.js';
import { validateRecipeCommand } from '../core/executor.js';
import { createMinimizeState, minimizeStep } from '../core/minimize.js';
import { recipeFromRun } from '../core/recipe.js';
import { replayRecipe } from '../core/replay.js';
import { computeSignature } from '../core/signature.js';
import { DEFAULT_RULESET_VERSION, getRuleset, rulesetVersions } from '../core/rules.js';
import type { Store } from '../core/store.js';
import type { ReplayRecipe } from '../core/types.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function sendText(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'content-type': 'application/x-ndjson; charset=utf-8' });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function rulesetFrom(url: URL) {
  const version = url.searchParams.get('ruleset') ?? DEFAULT_RULESET_VERSION;
  return getRuleset(version);
}

/**
 * 创建 /api 处理器。服务端只做确定性计算与持久化，
 * 绝不把 shell 执行能力暴露给浏览器。
 */
export function createApiHandler(store: Store, rootDir: string): Handler {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.replace(/^\/api/, '') || '/';
      const method = req.method ?? 'GET';
      const seg = path.split('/').filter(Boolean);

      if (method === 'GET' && path === '/health') {
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'GET' && path === '/rulesets') {
        return sendJson(res, 200, { versions: rulesetVersions(), default: DEFAULT_RULESET_VERSION });
      }
      if (method === 'POST' && path === '/import') {
        const body = await readBody(req);
        return sendJson(res, 200, store.importNdjson(body));
      }
      if (method === 'GET' && path === '/export') {
        return sendText(res, 200, store.exportNdjson() + '\n');
      }
      if (method === 'GET' && path === '/runs') {
        const ruleset = rulesetFrom(url);
        const runs = store.listRuns().map((run) => ({
          ...run,
          signature: ruleset ? computeSignature(run, ruleset) : null,
        }));
        return sendJson(res, 200, { runs });
      }
      if (method === 'GET' && seg[0] === 'runs' && seg[1]) {
        const run = store.getRun(seg[1]);
        if (!run) return sendJson(res, 404, { error: '运行不存在' });
        const ruleset = rulesetFrom(url);
        return sendJson(res, 200, {
          run,
          signature: ruleset ? computeSignature(run, ruleset) : null,
        });
      }
      if (method === 'GET' && path === '/clusters') {
        const ruleset = rulesetFrom(url);
        if (!ruleset) return sendJson(res, 400, { error: '未知规则集版本' });
        return sendJson(res, 200, { clusters: clusterRuns(store.listRuns(), ruleset) });
      }
      if (method === 'GET' && path === '/compare') {
        const a = store.getRun(url.searchParams.get('a') ?? '');
        const b = store.getRun(url.searchParams.get('b') ?? '');
        if (!a || !b) return sendJson(res, 404, { error: '运行不存在' });
        const ruleset = rulesetFrom(url);
        if (!ruleset) return sendJson(res, 400, { error: '未知规则集版本' });
        return sendJson(res, 200, {
          a: { run: a, signature: computeSignature(a, ruleset) },
          b: { run: b, signature: computeSignature(b, ruleset) },
          sameCluster: computeSignature(a, ruleset).hash === computeSignature(b, ruleset).hash,
        });
      }
      if (method === 'GET' && path === '/recipes') {
        return sendJson(res, 200, { recipes: store.listRecipes() });
      }
      if (method === 'POST' && path === '/recipes') {
        const body = JSON.parse(await readBody(req) || '{}') as { runId?: string };
        const run = store.getRun(body.runId ?? '');
        if (!run) return sendJson(res, 404, { error: '运行不存在' });
        const recipe = recipeFromRun(run, rootDir);
        store.saveRecipe(recipe);
        return sendJson(res, 201, { recipe });
      }
      if (seg[0] === 'recipes' && seg[1]) {
        const recipe = store.getRecipe(seg[1]);
        if (!recipe) return sendJson(res, 404, { error: '配方不存在' });

        if (method === 'GET' && seg.length === 2) {
          return sendJson(res, 200, { recipe });
        }
        if (method === 'PUT' && seg.length === 2) {
          const patch = JSON.parse(await readBody(req) || '{}') as Partial<ReplayRecipe>;
          const next: ReplayRecipe = {
            ...recipe,
            command: patch.command ?? recipe.command,
            args: patch.args ?? recipe.args,
            seed: patch.seed ?? recipe.seed,
            env: patch.env ?? recipe.env,
            virtualTime: patch.virtualTime ?? recipe.virtualTime,
            schedule: patch.schedule ?? recipe.schedule,
          };
          const validation = validateRecipeCommand(next.command, next.args, rootDir);
          if (!validation.ok) return sendJson(res, 422, { error: validation.reason });
          store.saveRecipe(next);
          return sendJson(res, 200, { recipe: next });
        }
        if (method === 'POST' && seg[2] === 'replay') {
          const original = store.getRun(recipe.runId);
          if (!original) return sendJson(res, 404, { error: '原始运行不存在' });
          const ruleset = rulesetFrom(url);
          if (!ruleset) return sendJson(res, 400, { error: '未知规则集版本' });
          return sendJson(res, 200, { outcome: replayRecipe(recipe, original, ruleset, rootDir) });
        }
        if (seg[2] === 'minimize') {
          if (method === 'POST' && seg[3] === 'start') {
            const body = JSON.parse(await readBody(req) || '{}') as { budget?: number };
            const budget = Math.max(0, Math.floor(body.budget ?? 20));
            const state = createMinimizeState(recipe, budget);
            store.saveMinimizer(state);
            return sendJson(res, 200, { state });
          }
          if (method === 'POST' && seg[3] === 'step') {
            const state = store.getMinimizer(recipe.id);
            if (!state) return sendJson(res, 400, { error: '最小化会话未开始' });
            const original = store.getRun(recipe.runId);
            if (!original) return sendJson(res, 404, { error: '原始运行不存在' });
            const ruleset = rulesetFrom(url);
            if (!ruleset) return sendJson(res, 400, { error: '未知规则集版本' });
            minimizeStep(state, (trial) => replayRecipe(trial, original, ruleset, rootDir));
            store.saveMinimizer(state);
            return sendJson(res, 200, { state });
          }
          if (method === 'GET' && seg.length === 3) {
            const state = store.getMinimizer(recipe.id);
            if (!state) return sendJson(res, 404, { error: '最小化会话不存在' });
            return sendJson(res, 200, { state });
          }
        }
      }
      return sendJson(res, 404, { error: `未知接口: ${method} ${path}` });
    } catch (err) {
      return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}
