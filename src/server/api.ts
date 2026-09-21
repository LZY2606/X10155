import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { clusterRuns } from "../core/cluster.js";
import { importNdjson } from "../core/store.js";
import { JsonPersistence } from "./persistence.js";
import { assertBodySize, guardRecipe, sanitizeRecipe } from "./guard.js";
import {
  recipeFromRun,
  replayRecipe,
  withExpectedSignatures,
  withRecipeId,
} from "../core/recipe.js";
import { advanceMinimizer, initMinimizer } from "../core/minimizer.js";
import { RULE_VERSIONS } from "../core/normalize.js";
import type { MinimizerState, ReplayRecipe, RuleVersion, RunRecord, StoredRun } from "../core/types.js";

export interface ApiOptions {
  dataFile: string;
  seedFile?: string;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function publicRecipe(recipe: ReplayRecipe) {
  return recipe;
}

function publicMinimizer(state: MinimizerState) {
  return {
    ...state,
    // 配方本体已在节点里；根配方也作为独立对象便于编辑面板引用。
    currentMinimalRecipe:
      state.nodes.find((node) => node.recipe.id === state.currentMinimalRecipeId)?.recipe ?? null,
  };
}

export function flakyReplayApi(options: ApiOptions): Plugin {
  const persistence = new JsonPersistence(options.dataFile, options.seedFile);

  const snapshot = () => {
    const state = persistence.read();
    const runs: StoredRun[] = state.runs.runs;
    const views = clusterRuns(runs);
    return {
      runs: runs.map((run) => ({
        fingerprint: run.fingerprint,
        importSeq: run.importSeq,
        testName: run.testName,
        status: run.status,
        exitCode: run.exitCode,
        stdoutSummary: run.stdoutSummary,
        stderrSummary: run.stderrSummary ?? "",
        seed: run.seed ?? null,
        env: run.env ?? {},
        tempPathPrefixes: run.tempPathPrefixes ?? [],
        durationMs: run.durationMs ?? null,
        virtualTime: run.virtualTime ?? [],
        schedule: run.schedule ?? [],
        recordedAt: run.recordedAt ?? null,
      })),
      clusters: views,
      ruleVersions: RULE_VERSIONS,
      recipes: Object.fromEntries(
        Object.entries(state.recipes).map(([id, recipe]) => [id, publicRecipe(recipe)]),
      ),
      minimizers: Object.fromEntries(
        Object.entries(state.minimizers).map(([id, minimizer]) => [id, publicMinimizer(minimizer)]),
      ),
    };
  };

  return {
    name: "flaky-replay-api",
    configureServer(server) {
      server.middlewares.use("/api", (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname;
        const method = req.method ?? "GET";

        const json = async (): Promise<unknown | null> => {
          const raw = await readBody(req);
          const tooLarge = assertBodySize(raw.length);
          if (tooLarge) {
            send(res, 413, { error: tooLarge });
            return null;
          }
          try {
            return JSON.parse(raw) as unknown;
          } catch {
            send(res, 400, { error: "请求体不是合法 JSON" });
            return null;
          }
        };

        const findRun = (fingerprint: string): StoredRun | null =>
          persistence.read().runs.runs.find((run) => run.fingerprint === fingerprint) ?? null;

        void (async () => {
          try {
            if (method === "GET" && path === "/state") {
              send(res, 200, snapshot());
              return;
            }

            if (method === "POST" && path === "/import") {
              const body = await json();
              if (body === null) return;
              const text =
                typeof body === "object" && body !== null && "ndjson" in body
                  ? String((body as { ndjson: unknown }).ndjson)
                  : typeof body === "string"
                    ? body
                    : "";
              if (!text) {
                send(res, 400, { error: "缺少 ndjson 字段" });
                return;
              }
              let report: { imported: string[]; duplicates: number; errors: Array<{ line: number; error: string }> } = { imported: [], duplicates: 0, errors: [] };
              persistence.mutate((draft) => {
                const result = importNdjson(draft.runs, text);
                draft.runs = result.state;
                report = {
                  imported: result.imported.map((run) => run.fingerprint),
                  duplicates: result.duplicates,
                  errors: result.errors,
                };
              });
              send(res, 200, { ...report, state: snapshot() });
              return;
            }

            if (method === "GET" && path === "/export") {
              res.writeHead(200, {
                "content-type": "application/x-ndjson; charset=utf-8",
                "content-disposition": 'attachment; filename="runs.ndjson"',
                "cache-control": "no-store",
              });
              res.end(persistence.exportRunsNdjson() + "\n");
              return;
            }

            if (method === "POST" && path === "/recipes") {
              const body = await json();
              if (body === null) return;
              const fingerprint =
                typeof body === "object" && body !== null && "fingerprint" in body
                  ? String((body as { fingerprint: unknown }).fingerprint)
                  : "";
              const run = findRun(fingerprint);
              if (!run) {
                send(res, 404, { error: "找不到该运行指纹" });
                return;
              }
              const base = recipeFromRun(run);
              const recipe = withExpectedSignatures(base, run as RunRecord);
              persistence.mutate((draft) => {
                draft.recipes[recipe.id] = recipe;
              });
              send(res, 201, { recipe, state: snapshot() });
              return;
            }

            // 编辑（或新建）配方：服务端重新做边界校验并重建受信配方。
            if (method === "PUT" && path.startsWith("/recipes/")) {
              const body = await json();
              if (body === null) return;
              if (typeof body !== "object" || body === null) {
                send(res, 400, { error: "配方必须是对象" });
                return;
              }
              const guard = guardRecipe(body);
              if (!guard.ok) {
                send(res, 400, { error: "配方越过执行器边界", details: guard.errors });
                return;
              }
              const derived =
                typeof (body as { derivedFromFingerprint?: unknown }).derivedFromFingerprint ===
                "string"
                  ? String((body as { derivedFromFingerprint: string }).derivedFromFingerprint)
                  : "";
              const recipe = sanitizeRecipe(
                body as Record<string, unknown>,
                derived,
                (recipeBody) => withRecipeId(recipeBody),
              );
              persistence.mutate((draft) => {
                draft.recipes[recipe.id] = recipe;
              });
              send(res, 200, { recipe, state: snapshot() });
              return;
            }

            if (method === "POST" && path.startsWith("/recipes/") && path.endsWith("/replay")) {
              const id = decodeURIComponent(path.slice("/recipes/".length, -"/replay".length));
              const recipe = persistence.read().recipes[id];
              if (!recipe) {
                send(res, 404, { error: "配方不存在" });
                return;
              }
              const result = replayRecipe(recipe);
              send(res, 200, { result });
              return;
            }

            if (method === "POST" && path.startsWith("/recipes/") && path.endsWith("/minimize")) {
              const id = decodeURIComponent(path.slice("/recipes/".length, -"/minimize".length));
              const recipe = persistence.read().recipes[id];
              if (!recipe) {
                send(res, 404, { error: "配方不存在" });
                return;
              }
              const body = (await json()) ?? {};
              const budget =
                typeof body === "object" && body !== null && "budget" in body
                  ? Number((body as { budget: unknown }).budget)
                  : 20;
              if (!Number.isInteger(budget) || budget <= 0 || budget > 1000) {
                send(res, 400, { error: "budget 必须是 1..1000 的整数" });
                return;
              }
              const ruleVersion: RuleVersion =
                typeof body === "object" && body !== null && "ruleVersion" in body
                  ? String((body as { ruleVersion: unknown }).ruleVersion)
                  : "rules-v1";
              const minimizer = initMinimizer({
                id: `min-${recipe.id}-${Date.now()}`,
                runFingerprint: recipe.derivedFromFingerprint,
                ruleVersion,
                baseRecipe: recipe,
                budget,
              });
              if (minimizer.status === "initial") {
                send(res, 409, {
                  error: "起点配方未能复现失败，无法最小化",
                  minimizer: publicMinimizer(minimizer),
                });
                return;
              }
              persistence.mutate((draft) => {
                draft.minimizers[minimizer.id] = minimizer;
              });
              send(res, 201, { minimizer: publicMinimizer(minimizer), state: snapshot() });
              return;
            }

            if (method === "POST" && path.startsWith("/minimizers/") && path.endsWith("/advance")) {
              const id = decodeURIComponent(path.slice("/minimizers/".length, -"/advance".length));
              const current = persistence.read().minimizers[id];
              if (!current) {
                send(res, 404, { error: "最小化会话不存在" });
                return;
              }
              const body = (await json()) ?? {};
              const steps =
                typeof body === "object" && body !== null && "steps" in body
                  ? Number((body as { steps: unknown }).steps)
                  : 1;
              if (!Number.isInteger(steps) || steps <= 0 || steps > 100) {
                send(res, 400, { error: "steps 必须是 1..100 的整数" });
                return;
              }
              const next = advanceMinimizer(current, steps);
              persistence.mutate((draft) => {
                draft.minimizers[id] = next;
              });
              send(res, 200, { minimizer: publicMinimizer(next), state: snapshot() });
              return;
            }

            if (method === "POST" && path === "/guard-check") {
              const body = await json();
              const guard = guardRecipe(body);
              send(res, guard.ok ? 200 : 400, { ok: guard.ok, errors: guard.errors });
              return;
            }

            send(res, 404, { error: `未知 API: ${method} ${path}` });
          } catch (error) {
            send(res, 500, { error: `服务器内部错误: ${(error as Error).message}` });
          }
        })();
      });
    },
  };
}
