import { runFingerprint } from "./normalize.js";
import type { RunRecord, StoredRun } from "./types.js";

export interface StoreState {
  version: 1;
  /** 原始运行按导入顺序排列，永不删除、永不就地改写。 */
  runs: StoredRun[];
  seq: number;
}

export function emptyStore(): StoreState {
  return { version: 1, runs: [], seq: 0 };
}

export interface ImportReport {
  state: StoreState;
  imported: StoredRun[];
  /** 指纹已存在而被跳过的记录（原始行仍被报告，不静默吞掉）。 */
  duplicates: number;
  errors: Array<{ line: number; error: string }>;
}

/**
 * 导入 NDJSON 文本：
 *  - 坏行报错但不中断整批导入
 *  - 缺省指纹时按规范字段计算；带指纹时以内容重新计算，不一致则报错
 *  - 重复指纹跳过，原始已存运行始终保留
 */
export function importNdjson(state: StoreState, text: string): ImportReport {
  const lines = text.split(/\r?\n/);
  const existing = new Set(state.runs.map((run) => run.fingerprint));
  const next: StoreState = { ...state, runs: [...state.runs] };
  const imported: StoredRun[] = [];
  const errors: ImportReport["errors"] = [];
  let duplicates = 0;
  let seq = state.seq;

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    let parsed: RunRecord;
    try {
      parsed = JSON.parse(line) as RunRecord;
    } catch (error) {
      errors.push({ line: index + 1, error: `不是合法 JSON: ${(error as Error).message}` });
      return;
    }
    const validation = validateRun(parsed);
    if (validation) {
      errors.push({ line: index + 1, error: validation });
      return;
    }
    const fingerprint = runFingerprint(parsed);
    if (parsed.fingerprint !== undefined && parsed.fingerprint !== fingerprint) {
      errors.push({
        line: index + 1,
        error: `运行指纹与内容不一致（记录为 ${parsed.fingerprint.slice(0, 20)}…，按内容计算为 ${fingerprint.slice(0, 20)}…）`,
      });
      return;
    }
    if (existing.has(fingerprint)) {
      duplicates += 1;
      return;
    }
    existing.add(fingerprint);
    const stored: StoredRun = { ...parsed, fingerprint, importSeq: seq };
    seq += 1;
    next.runs.push(stored);
    imported.push(stored);
  });

  next.seq = seq;
  next.runs.sort((a, b) => a.importSeq - b.importSeq);
  return { state: next, imported, duplicates, errors };
}

function validateRun(run: RunRecord): string | null {
  if (run === null || typeof run !== "object") return "记录不是对象";
  if (typeof run.testName !== "string" || run.testName.length === 0) return "缺少 testName";
  if (!["pass", "fail", "timeout", "crash"].includes(run.status)) return "status 非法";
  if (typeof run.exitCode !== "number") return "缺少数值型 exitCode";
  if (typeof run.stdoutSummary !== "string") return "缺少 stdoutSummary 字符串";
  if (run.env !== undefined && (typeof run.env !== "object" || Array.isArray(run.env)))
    return "env 必须是对象";
  if (run.tempPathPrefixes !== undefined && !Array.isArray(run.tempPathPrefixes))
    return "tempPathPrefixes 必须是数组";
  if (run.schedule !== undefined) {
    if (!Array.isArray(run.schedule)) return "schedule 必须是数组";
    for (const step of run.schedule) {
      if (
        typeof step?.order !== "number" ||
        typeof step.actor !== "string" ||
        typeof step.op !== "string"
      ) {
        return "schedule 事件结构非法";
      }
    }
  }
  if (run.virtualTime !== undefined) {
    if (!Array.isArray(run.virtualTime)) return "virtualTime 必须是数组";
    for (const event of run.virtualTime) {
      if (typeof event?.atMs !== "number" || typeof event.kind !== "string") {
        return "virtualTime 事件结构非法";
      }
    }
  }
  return null;
}

/** 导出 NDJSON：保持运行指纹与导入顺序。 */
export function exportNdjson(state: StoreState): string {
  return state.runs
    .slice()
    .sort((a, b) => a.importSeq - b.importSeq)
    .map((run) => JSON.stringify(run))
    .join("\n");
}
