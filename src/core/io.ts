import { runFingerprint } from './fingerprint.js';
import type { RunRecord } from './types.js';

/** 单条导入错误：行号（1 基）与原因。 */
export interface ImportIssue {
  line: number;
  message: string;
}

export interface ParsedNdjson {
  runs: RunRecord[];
  issues: ImportIssue[];
}

/**
 * 解析 NDJSON。结构化校验失败的行会上报 issue；
 * 服务端可以据此整批拒绝（避免部分导入造成歧义）。
 */
export function parseNdjson(text: string): ParsedNdjson {
  const runs: RunRecord[] = [];
  const issues: ImportIssue[] = [];

  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === '') {
      return;
    }
    const lineNo = index + 1;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      issues.push({ line: lineNo, message: `JSON 解析失败: ${(error as Error).message}` });
      return;
    }
    const issue = validateRun(value);
    if (issue) {
      issues.push({ line: lineNo, message: issue });
      return;
    }
    runs.push(normalizeShape(value as RunRecord));
  });

  return { runs, issues };
}

function normalizeShape(run: RunRecord): RunRecord {
  const shape = {
    testName: run.testName,
    exitStatus: run.exitStatus,
    stdoutSummary: run.stdoutSummary,
    stderrSummary: run.stderrSummary,
    seed: run.seed,
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    tempPathRoots: run.tempPathRoots ?? [],
    envWhitelist: run.envWhitelist ?? {},
    virtualTimeEvents: run.virtualTimeEvents ?? [],
    scheduleDecisions: run.scheduleDecisions ?? [],
    error: run.error ?? null,
  };
  // 导出文件会在每条记录末尾附带指纹：保留这个字段交给 Store 校验，但它不参与指纹计算。
  const declared = (run as RunRecord & { fingerprint?: unknown }).fingerprint;
  if (typeof declared === 'string') {
    (shape as RunRecord & { fingerprint?: string }).fingerprint = declared;
  }
  return shape;
}

export function validateRun(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return '运行记录必须是 JSON 对象';
  }
  const run = value as Record<string, unknown>;
  const stringField = (key: string): string | null =>
    typeof run[key] === 'string' ? null : `字段 ${key} 必须是字符串`;
  for (const key of ['testName', 'stdoutSummary', 'stderrSummary', 'seed', 'startedAt']) {
    const issue = stringField(key);
    if (issue) {
      return issue;
    }
  }
  if (!Number.isInteger(run.exitStatus)) {
    return '字段 exitStatus 必须是整数';
  }
  if (!Number.isFinite(run.durationMs)) {
    return '字段 durationMs 必须是有限数字';
  }
  if (typeof run.envWhitelist !== 'object' || run.envWhitelist === null || Array.isArray(run.envWhitelist)) {
    return '字段 envWhitelist 必须是字符串到字符串的对象';
  }
  for (const [key, envValue] of Object.entries(run.envWhitelist as Record<string, unknown>)) {
    if (typeof key !== 'string' || typeof envValue !== 'string') {
      return 'envWhitelist 的键和值都必须是字符串';
    }
  }
  if (!Array.isArray(run.virtualTimeEvents) || !Array.isArray(run.scheduleDecisions)) {
    return 'virtualTimeEvents 与 scheduleDecisions 必须是数组';
  }
  const arrayIssue = validateEventArrays(run);
  if (arrayIssue) {
    return arrayIssue;
  }
  if (run.tempPathRoots !== undefined) {
    if (!Array.isArray(run.tempPathRoots) || run.tempPathRoots.some((p) => typeof p !== 'string')) {
      return 'tempPathRoots 必须是字符串数组';
    }
  }
  if (run.error !== null && run.error !== undefined) {
    const errorIssue = validateError(run.error);
    if (errorIssue) {
      return errorIssue;
    }
  }
  return null;
}

function validateEventArrays(run: Record<string, unknown>): string | null {
  for (const event of run.virtualTimeEvents as unknown[]) {
    if (typeof event !== 'object' || event === null) {
      return 'virtualTimeEvents 的元素必须是对象';
    }
    const e = event as Record<string, unknown>;
    if (!Number.isInteger(e.seq) || !Number.isFinite(e.atMs) || typeof e.kind !== 'string') {
      return '虚拟时间事件需要整数 seq、数字 atMs 与字符串 kind';
    }
  }
  for (const decision of run.scheduleDecisions as unknown[]) {
    if (typeof decision !== 'object' || decision === null) {
      return 'scheduleDecisions 的元素必须是对象';
    }
    const d = decision as Record<string, unknown>;
    if (
      !Number.isInteger(d.step) ||
      typeof d.point !== 'string' ||
      typeof d.resource !== 'string' ||
      typeof d.selected !== 'string' ||
      !Array.isArray(d.waiters) ||
      d.waiters.some((w) => typeof w !== 'string')
    ) {
      return '调度决策需要整数 step、字符串 point/resource/selected 与字符串数组 waiters';
    }
  }
  return null;
}

function validateError(value: unknown): string | null {
  const error = value as Record<string, unknown>;
  if (typeof error.type !== 'string' || typeof error.message !== 'string') {
    return 'error 需要字符串 type 与 message';
  }
  if (error.line !== undefined && !Number.isInteger(error.line)) {
    return 'error.line 必须是整数';
  }
  if (error.assertion !== undefined && error.assertion !== null) {
    const assertion = error.assertion as Record<string, unknown>;
    if (typeof assertion.expected !== 'string' || typeof assertion.actual !== 'string') {
      return 'error.assertion 需要字符串 expected 与 actual';
    }
  }
  return null;
}

/** 导出为 NDJSON，顺序遵循 runOrder（稳定），每条附带运行指纹字段。 */
export function exportNdjson(
  runs: RunRecord[],
  fingerprints: string[],
): string {
  return runs
    .map((run, index) => {
      // fingerprint 放最后，保证展开 ...run 不会覆盖它。
      return JSON.stringify({ ...run, fingerprint: fingerprints[index] ?? runFingerprint(run) });
    })
    .join('\n')
    .concat('\n');
}
