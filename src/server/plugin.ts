import type { Plugin, ViteDevServer } from "vite";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Store } from "./store";
import { clusterRuns } from "../core/cluster";
import { diffSummaries, failureSignatureForCompare } from "./compare";
import { recipeFromRun } from "../core/recipe";
import { replayRecipe } from "../core/replay";
import {
  createSession,
  minimizationTick,
} from "../core/minimize";
import type {
  MinimizeSession,
  ReplayRecipe,
  RuleVersion,
  TestRun,
} from "../core/types";

const API_PREFIX = "/api/";

export function apiPlugin(): Plugin {
  let store: Store;
  return {
    name: "flaky-replay-api",
    configureServer(server: ViteDevServer) {
      store = ensureStore();
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith(API_PREFIX)) {
          next();
          return;
        }
        void handle(store, req, res, next).catch((error: unknown) => {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });
    },
  };
}

function ensureStore(): Store {
  const dataFile = join(process.cwd(), ".data", "flaky-store.json");
  const sampleFile = join(process.cwd(), "sample-data", "runs.ndjson");
  const store = new Store(dataFile, () => ({
    runs: [],
    recipes: [],
    sessions: [],
    ruleVersions: ["v1", "v2"],
    activeRuleVersion: "v1",
  }));
  if (store.getRuns().length === 0 && existsSync(sampleFile)) {
    const lines = readFileSync(sampleFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    store.importRecords(lines, {
      now: () => new Date(),
    });
  }
  return store;
}

async function handle(
  store: Store,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  next: () => void,
): Promise<void> {
  const url = new URL(req.url ?? "", "http://localhost");
  const route = url.pathname.slice(API_PREFIX.length);
  const method = req.method ?? "GET";

  if (method === "GET" && route === "state") {
    const version = (url.searchParams.get("version") as RuleVersion) ??
      store.getActiveRuleVersion();
    const runs = store.getRuns();
    sendJson(res, 200, {
      runs,
      clusters: clusterRuns(runs, version),
      recipes: store.getRecipes(),
      sessions: store.snapshot().sessions,
      ruleVersions: store.snapshot().ruleVersions,
      activeRuleVersion: store.getActiveRuleVersion(),
    });
    return;
  }

  if (method === "POST" && route === "rule-version") {
    const body = await readJson<{ version: RuleVersion }>(req);
    if (body.version !== "v1" && body.version !== "v2") {
      sendJson(res, 400, { error: "未知规则版本" });
      return;
    }
    store.setActiveRuleVersion(body.version);
    sendJson(res, 200, { activeRuleVersion: body.version });
    return;
  }

  if (method === "POST" && route === "import") {
    const body = await readJson<{
      ndjson?: string;
      records?: unknown[];
      recomputeFingerprint?: boolean;
    }>(req);
    const records =
      body.records ??
      (body.ndjson ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, index) => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return {
              __parseError: `第 ${index + 1} 行不是合法 JSON`,
            };
          }
        });
    const parseErrors = records
      .map((record) =>
        record && typeof record === "object" && "__parseError" in record
          ? String((record as { __parseError: string }).__parseError)
          : null,
      )
      .filter((value): value is string => value !== null);
    const clean = records.filter(
      (record) =>
        !record ||
        typeof record !== "object" ||
        !("__parseError" in record),
    );
    const result = store.importRecords(clean, {
      now: () => new Date(),
      recomputeFingerprint: body.recomputeFingerprint,
    });
    result.errors.unshift(...parseErrors);
    sendJson(res, 200, result);
    return;
  }

  if (method === "GET" && route === "export") {
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="runs-export.ndjson"',
    );
    res.end(store.exportNdjson());
    return;
  }

  if (method === "GET" && route === "runs") {
    sendJson(res, 200, { runs: store.getRuns() });
    return;
  }

  if (method === "GET" && route.startsWith("runs/")) {
    const run = store.getRun(route.slice(5));
    if (!run) {
      sendJson(res, 404, { error: "运行不存在" });
      return;
    }
    sendJson(res, 200, run);
    return;
  }

  if (method === "GET" && route === "clusters") {
    const version = (url.searchParams.get("version") as RuleVersion | null) ??
      store.getActiveRuleVersion();
    sendJson(res, 200, { clusters: clusterRuns(store.getRuns(), version) });
    return;
  }

  if (method === "POST" && route === "compare") {
    const body = await readJson<{ a: string; b: string }>(req);
    const a = store.getRun(body.a);
    const b = store.getRun(body.b);
    if (!a || !b) {
      sendJson(res, 404, { error: "运行不存在" });
      return;
    }
    sendJson(res, 200, {
      a: failureSignatureForCompare(a),
      b: failureSignatureForCompare(b),
      tokens: diffSummaries(
        failureSignatureForCompare(a).normalizedSummary,
        failureSignatureForCompare(b).normalizedSummary,
      ),
    });
    return;
  }

  if (method === "POST" && route === "recipes") {
    const body = await readJson<{ runId: string }>(req);
    const run = store.getRun(body.runId);
    if (!run) {
      sendJson(res, 404, { error: "运行不存在" });
      return;
    }
    const recipe = recipeFromRun(run);
    recipe.createdAt = new Date().toISOString();
    store.saveRecipe(recipe);
    sendJson(res, 201, recipe);
    return;
  }

  if (method === "GET" && route === "recipes") {
    sendJson(res, 200, { recipes: store.getRecipes() });
    return;
  }

  if (method === "GET" && route.startsWith("recipes/")) {
    const recipe = store.getRecipe(route.slice(8));
    if (!recipe) {
      sendJson(res, 404, { error: "配方不存在" });
      return;
    }
    sendJson(res, 200, recipe);
    return;
  }

  if (method === "PUT" && route.startsWith("recipes/")) {
    const id = route.slice(8);
    const existing = store.getRecipe(id);
    if (!existing) {
      sendJson(res, 404, { error: "配方不存在" });
      return;
    }
    const body = await readJson<Partial<ReplayRecipe>>(req);
    const updated: ReplayRecipe = {
      ...existing,
      ...body,
      id: existing.id,
      sourceRunId: existing.sourceRunId,
      program: existing.program,
    };
    store.saveRecipe(updated);
    sendJson(res, 200, updated);
    return;
  }

  if (method === "DELETE" && route.startsWith("recipes/")) {
    store.deleteRecipe(route.slice(8));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && route.startsWith("recipes/") && route.endsWith("/replay")) {
    const id = route.slice("recipes/".length, -"/replay".length);
    const recipe = store.getRecipe(id);
    if (!recipe) {
      sendJson(res, 404, { error: "配方不存在" });
      return;
    }
    const target = store.getRun(recipe.sourceRunId);
    if (!target) {
      sendJson(res, 404, { error: "源运行不存在" });
      return;
    }
    sendJson(res, 200, replayRecipe(recipe, target));
    return;
  }

  if (method === "POST" && route.startsWith("recipes/") && route.endsWith("/minimize")) {
    const id = route.slice("recipes/".length, -"/minimize".length);
    const recipe = store.getRecipe(id);
    if (!recipe) {
      sendJson(res, 404, { error: "配方不存在" });
      return;
    }
    const target = store.getRun(recipe.sourceRunId);
    if (!target) {
      sendJson(res, 404, { error: "源运行不存在" });
      return;
    }
    const body = await readJson<{ budget?: number }>(req);
    const budget = Math.max(1, Math.min(500, body.budget ?? 20));
    const session = createSession({
      id: `min-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      recipe,
      targetRun: target,
      budget,
    });
    session.targetSignature = signatureOf(target);
    store.saveSession(session);
    sendJson(res, 201, { session, recipe });
    return;
  }

  if (method === "POST" && route.startsWith("minimize/") && route.endsWith("/step")) {
    const id = route.slice("minimize/".length, -"/step".length);
    const session = store.getSession(id);
    if (!session) {
      sendJson(res, 404, { error: "最小化会话不存在" });
      return;
    }
    const recipe = store.getRecipe(session.recipeId);
    const target = store.getRun(
      recipe?.sourceRunId ?? "",
    );
    if (!recipe || !target) {
      sendJson(res, 404, { error: "配方或源运行不存在" });
      return;
    }
    const tick = minimizationTick(session, recipe, target);
    store.saveSession(tick.session);
    if (tick.attempt?.accepted) store.saveRecipe(tick.recipe);
    sendJson(res, 200, {
      session: tick.session,
      recipe: tick.recipe,
      attempt: tick.attempt ?? null,
    });
    return;
  }

  if (method === "GET" && route.startsWith("minimize/")) {
    const session = store.getSession(route.slice(9));
    if (!session) {
      sendJson(res, 404, { error: "会话不存在" });
      return;
    }
    sendJson(res, 200, session);
    return;
  }

  if (method === "POST" && route === "reset") {
    store.reset({
      runs: [],
      recipes: [],
      sessions: [],
      ruleVersions: ["v1", "v2"],
      activeRuleVersion: "v1",
    });
    const sampleFile = join(process.cwd(), "sample-data", "runs.ndjson");
    if (existsSync(sampleFile)) {
      const lines = readFileSync(sampleFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      store.importRecords(lines, { now: () => new Date() });
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: `未知 API 路由 ${method} ${route}` });
  void next;
}

function signatureOf(run: TestRun): string {
  return failureSignatureForCompare(run).signature;
}

function sendJson(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function readJson<T>(req: import("node:http").IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(text) as T);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

export type { MinimizeSession };
