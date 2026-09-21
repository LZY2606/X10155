import { readFileSync } from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Store } from "./store.js";
import { executeRecipe, loadManifest, EXECUTOR_PATH } from "./runner.js";
import { parseNdjson, serializeExport } from "../core/ndjson.js";
import { runFingerprint } from "../core/fingerprint.js";
import {
  normalizeFailureOutput,
  CURRENT_RULE_VERSION,
  RULE_SET_VERSIONS,
} from "../core/normalize.js";
import { buildClusterView } from "../core/cluster.js";
import { runReplay } from "../core/replay.js";
import { minimizeRecipe } from "../core/minimize.js";
import type { Recipe, StoredRun } from "../core/types.js";

type JsonBody = Record<string, unknown>;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export function createApiHandler(store: Store) {
  const normCtx = () => ({ tempPaths: store.data.settings.tempPaths });

  function rebuildCurrentView() {
    const view = buildClusterView(store.data.runs, normCtx(), CURRENT_RULE_VERSION);
    store.data.views[String(CURRENT_RULE_VERSION)] = view;
  }

  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = url.pathname.replace(/^\/api/, "") || "/";
    const method = req.method ?? "GET";
    const body: JsonBody =
      method === "POST" || method === "PUT"
        ? ((await readBody(req).then((t) => (t ? JSON.parse(t) : {}))) as JsonBody)
        : {};

    if (route === "/state" && method === "GET") {
      const manifest = await loadManifest();
      sendJson(res, 200, {
        runs: store.data.runs,
        views: store.data.views,
        recipes: store.data.recipes,
        minimizations: store.data.minimizations,
        settings: store.data.settings,
        ruleVersions: RULE_SET_VERSIONS,
        currentRuleVersion: CURRENT_RULE_VERSION,
        executor: { path: EXECUTOR_PATH, manifest },
      });
      return;
    }

    if (route === "/sample" && method === "GET") {
      const sample = readFileSync(
        path.resolve("examples/sample-runs.ndjson"),
        "utf8",
      );
      sendJson(res, 200, { ndjson: sample });
      return;
    }

    if (route === "/import" && method === "POST") {
      if (Array.isArray(body.tempPaths)) {
        store.data.settings.tempPaths = body.tempPaths.map(String);
      }
      const parsed = parseNdjson(String(body.ndjson ?? ""));
      const seen = new Set(store.data.runs.map((r) => r.fingerprint));
      let imported = 0;
      let duplicates = 0;
      for (const run of parsed) {
        const fingerprint = runFingerprint(run);
        if (seen.has(fingerprint)) {
          duplicates += 1;
          continue;
        }
        seen.add(fingerprint);
        const norm = normalizeFailureOutput(run.stdout, normCtx(), CURRENT_RULE_VERSION);
        const stored: StoredRun = {
          ...run,
          id: run.id || newId("run"),
          fingerprint,
          signature: norm.signature,
          importedAt: new Date().toISOString(),
        };
        store.data.runs.push(stored);
        imported += 1;
      }
      rebuildCurrentView();
      store.save();
      sendJson(res, 200, {
        imported,
        duplicates,
        total: store.data.runs.length,
      });
      return;
    }

    if (route === "/export" && method === "GET") {
      const views = Object.values(store.data.views);
      res.statusCode = 200;
      res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
      res.end(serializeExport(store.data.runs, views));
      return;
    }

    if (route === "/compare" && method === "GET") {
      const a = store.data.runs.find((r) => r.id === url.searchParams.get("a"));
      const b = store.data.runs.find((r) => r.id === url.searchParams.get("b"));
      if (!a || !b) {
        sendJson(res, 404, { error: "运行不存在" });
        return;
      }
      const normA = normalizeFailureOutput(a.stdout, normCtx(), CURRENT_RULE_VERSION);
      const normB = normalizeFailureOutput(b.stdout, normCtx(), CURRENT_RULE_VERSION);
      sendJson(res, 200, {
        a: { run: a, normalized: normA },
        b: { run: b, normalized: normB },
        sameSignature: normA.signature === normB.signature,
      });
      return;
    }

    if (route === "/settings" && method === "POST") {
      if (Array.isArray(body.tempPaths)) {
        store.data.settings.tempPaths = body.tempPaths.map(String);
        rebuildCurrentView();
        store.save();
      }
      sendJson(res, 200, { settings: store.data.settings });
      return;
    }

    if (route === "/reset" && method === "POST") {
      store.reset();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (route === "/recipes" && method === "POST") {
      const run = store.data.runs.find((r) => r.id === body.runId);
      if (!run) {
        sendJson(res, 404, { error: "运行不存在" });
        return;
      }
      const recipe: Recipe = {
        id: newId("recipe"),
        name: `重放 ${run.testName} (${run.id})`,
        baseRunId: run.id,
        executorPath: EXECUTOR_PATH,
        args: [],
        testName: run.testName,
        seed: run.seed,
        env: { ...run.env },
        schedule: [...run.schedule],
        virtualTimeEvents: [...run.virtualTimeEvents],
        lastOutcome: null,
      };
      store.data.recipes.push(recipe);
      store.save();
      sendJson(res, 200, { recipe });
      return;
    }

    const recipeMatch = route.match(/^\/recipes\/([^/]+)(\/(replay|minimize))?$/);
    if (recipeMatch) {
      const recipe = store.data.recipes.find((r) => r.id === recipeMatch[1]);
      if (!recipe) {
        sendJson(res, 404, { error: "配方不存在" });
        return;
      }
      const action = recipeMatch[3];
      if (!action && method === "PUT") {
        const patch = body as Partial<Recipe>;
        if (typeof patch.name === "string") recipe.name = patch.name;
        if (typeof patch.seed === "number") recipe.seed = patch.seed;
        if (patch.env && typeof patch.env === "object") {
          recipe.env = Object.fromEntries(
            Object.entries(patch.env).map(([k, v]) => [k, String(v)]),
          );
        }
        if (Array.isArray(patch.schedule)) recipe.schedule = patch.schedule.map(String);
        if (Array.isArray(patch.virtualTimeEvents)) {
          recipe.virtualTimeEvents = patch.virtualTimeEvents.map(String);
        }
        store.save();
        sendJson(res, 200, { recipe });
        return;
      }
      const original = store.data.runs.find((r) => r.id === recipe.baseRunId);
      if (!original) {
        sendJson(res, 400, { error: "原始运行已被删除" });
        return;
      }
      const manifest = await loadManifest();
      if (action === "replay" && method === "POST") {
        const result = await runReplay(recipe, original, {
          manifest,
          execute: executeRecipe,
          normCtx: normCtx(),
        });
        recipe.lastOutcome = result.outcome;
        store.save();
        sendJson(res, 200, { result });
        return;
      }
      if (action === "minimize" && method === "POST") {
        const budget = Math.max(0, Number(body.budget ?? 20));
        const result = await minimizeRecipe(
          recipe,
          (trial) =>
            runReplay(trial, original, {
              manifest,
              execute: executeRecipe,
              normCtx: normCtx(),
            }),
          budget,
        );
        store.data.minimizations[recipe.id] = result;
        store.save();
        sendJson(res, 200, { result });
        return;
      }
    }

    sendJson(res, 404, { error: `未知接口 ${method} ${route}` });
  };
}
