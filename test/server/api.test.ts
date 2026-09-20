import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { apiPlugin } from "../../src/server/plugin";

const ORIGINAL_CWD = process.cwd();

let server: ViteDevServer;
let port: number;
let baseUrl: string;

async function call<T>(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as T) : ({} as T),
  };
}

beforeAll(async () => {
  server = await createServer({
    root: ORIGINAL_CWD,
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
    configFile: false,
    plugins: [apiPlugin()],
  });
  await server.listen();
  const httpServer = server.httpServer;
  if (!httpServer) throw new Error("dev server has no http server");
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("no ephemeral port");
  }
  port = address.port;
  baseUrl = `http://127.0.0.1:${port}`;
  // Reset to committed samples.
  await call("/api/reset", { method: "POST" });
}, 30000);

afterAll(async () => {
  await server.close();
});

describe("HTTP API end to end", () => {
  it("seeds clusters from committed samples and serves state", async () => {
    const state = await call<{
      runs: unknown[];
      clusters: { memberIds: string[] }[];
    }>("/api/state?version=v1");
    expect(state.status).toBe(200);
    expect(state.body.runs.length).toBeGreaterThanOrEqual(8);
    const timerCluster = state.body.clusters.find(
      (cluster) => cluster.memberIds.length === 2,
    );
    expect(timerCluster).toBeDefined();
  });

  it("v2 merges the pid/uuid runs that v1 keeps apart", async () => {
    const v1 = await call<{ clusters: { memberIds: string[] }[] }>(
      "/api/state?version=v1",
    );
    const v2 = await call<{ clusters: { memberIds: string[] }[] }>(
      "/api/state?version=v2",
    );
    const flush1 = v1.body.clusters.filter((cluster) =>
      cluster.memberIds.some((id) => id.startsWith("run-pid-uuid")),
    );
    const flush2 = v2.body.clusters.filter((cluster) =>
      cluster.memberIds.some((id) => id.startsWith("run-pid-uuid")),
    );
    expect(flush1).toHaveLength(2);
    expect(flush2).toHaveLength(1);
    expect(flush2[0].memberIds).toEqual([
      "run-pid-uuid-a",
      "run-pid-uuid-b",
    ]);
  });

  it("creates a recipe, replays reproduced, and reports env incompatibility", async () => {
    const created = await call<{ id: string }>("/api/recipes", {
      method: "POST",
      body: JSON.stringify({ runId: "run-timer-01" }),
    });
    expect(created.status).toBe(201);
    const recipeId = created.body.id;

    const replay = await call<{ outcome: string }>(
      `/api/recipes/${recipeId}/replay`,
      { method: "POST" },
    );
    expect(replay.body.outcome).toBe("reproduced");

    const edited = await call<{ env: Record<string, string> }>(
      `/api/recipes/${recipeId}`,
      {
        method: "PUT",
        body: JSON.stringify({ env: { TIMER_MODE: "virtual" } }),
      },
    );
    // TMPDIR/RUN_ID removed: signature changes -> not-reproduced, never pass.
    expect(edited.status).toBe(200);
    const replay2 = await call<{ outcome: string }>(
      `/api/recipes/${recipeId}/replay`,
      { method: "POST" },
    );
    expect(["not-reproduced"]).toContain(replay2.body.outcome);

    await call(`/api/recipes/${recipeId}`, {
      method: "PUT",
      body: JSON.stringify({ env: { TIMER_MODE: "nope" } }),
    });
    const replay3 = await call<{ outcome: string; reason?: string }>(
      `/api/recipes/${recipeId}/replay`,
      { method: "POST" },
    );
    expect(replay3.body.outcome).toBe("env-incompatible");
  });

  it("runs stepwise minimization and stops at budget", async () => {
    const created = await call<{ id: string }>(
      "/api/recipes",
      { method: "POST", body: JSON.stringify({ runId: "run-timer-01" }) },
    );
    const session = await call<{
      session: { id: string; budget: number };
    }>(`/api/recipes/${created.body.id}/minimize`, {
      method: "POST",
      body: JSON.stringify({ budget: 2 }),
    });
    const sessionId = session.body.session.id;

    await call(`/api/minimize/${sessionId}/step`, { method: "POST" });
    const step2 = await call<{
      session: { attemptsUsed: number; status: string; globalMinimumClaimed: boolean };
    }>(`/api/minimize/${sessionId}/step`, { method: "POST" });
    expect(step2.body.session.attemptsUsed).toBe(2);
    expect(step2.body.session.status).toBe("budget-exhausted");
    expect(step2.body.session.globalMinimumClaimed).toBe(false);

    const step3 = await call<{
      session: { attemptsUsed: number; status: string };
    }>(`/api/minimize/${sessionId}/step`, { method: "POST" });
    expect(step3.body.session.attemptsUsed).toBe(2);
  });

  it("rejects path-escape attempts through recipes", async () => {
    const created = await call<{ id: string }>(
      "/api/recipes",
      { method: "POST", body: JSON.stringify({ runId: "run-env-old" }) },
    );
    await call(`/api/recipes/${created.body.id}`, {
      method: "PUT",
      body: JSON.stringify({
        env: { REQUIRED_SDK: "2.1", TMPDIR: "/tmp/x/../../etc" },
      }),
    });
    const replay = await call<{ outcome: string; reason?: string }>(
      `/api/recipes/${created.body.id}/replay`,
      { method: "POST" },
    );
    expect(replay.body.outcome).toBe("env-incompatible");
    expect(replay.body.reason).toMatch(/\.\./);
  });

  it("export returns NDJSON with fingerprints in import order", async () => {
    const response = await fetch(`${baseUrl}/api/export`);
    const text = await response.text();
    const lines = text.trim().split("\n");
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { fingerprint?: string; id?: string };
      expect(parsed.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(parsed.id).toBeTruthy();
    }
    expect(JSON.parse(lines[0]).id).toBe("run-timer-01");
  });
});
