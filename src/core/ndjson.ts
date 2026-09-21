import type { ClusterView, RunRecord, StoredRun } from "./types.js";

export interface ParsedRunLine {
  run: RunRecord;
}

export function parseRunRecord(raw: unknown, lineNo: number): RunRecord {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`第 ${lineNo} 行：不是对象`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.testName !== "string" || !obj.testName) {
    throw new Error(`第 ${lineNo} 行：缺少 testName`);
  }
  if (typeof obj.exitStatus !== "number") {
    throw new Error(`第 ${lineNo} 行：缺少 exitStatus`);
  }
  if (typeof obj.seed !== "number") {
    throw new Error(`第 ${lineNo} 行：缺少 seed`);
  }
  const env = (obj.env ?? {}) as Record<string, unknown>;
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) cleanEnv[k] = String(v);
  const asStrings = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String) : [];
  return {
    id: typeof obj.id === "string" && obj.id ? obj.id : "",
    testName: obj.testName,
    exitStatus: obj.exitStatus,
    stdout: typeof obj.stdout === "string" ? obj.stdout : "",
    seed: obj.seed,
    env: cleanEnv,
    virtualTimeEvents: asStrings(obj.virtualTimeEvents),
    schedule: asStrings(obj.schedule),
  };
}

export function parseNdjson(text: string): RunRecord[] {
  const runs: RunRecord[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`第 ${i + 1} 行：JSON 解析失败`);
    }
    // 兼容导出信封格式
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>).type === "clusterView"
    ) {
      return;
    }
    const payload =
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>).type === "run"
        ? (parsed as Record<string, unknown>).run
        : parsed;
    runs.push(parseRunRecord(payload, i + 1));
  });
  return runs;
}

export function serializeExport(
  runs: StoredRun[],
  views: ClusterView[],
): string {
  const lines: string[] = [];
  for (const run of runs) {
    lines.push(JSON.stringify({ type: "run", run }));
  }
  for (const view of views) {
    lines.push(JSON.stringify({ type: "clusterView", view }));
  }
  return lines.join("\n") + "\n";
}
