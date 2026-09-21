import { runFingerprint } from './fingerprint';
import type {
  ExportBundle,
  ImportReport,
  RunRecord,
  ScheduleEvent,
  VirtualTimeEvent,
} from './types';

export function toNDJSON(runs: readonly RunRecord[]): string {
  return runs.map((run) => JSON.stringify(run)).join('\n') + '\n';
}

function fail(errors: ImportReport['errors'], line: number, message: string): void {
  errors.push({ line, error: message });
}

function asFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function asString(value: unknown): value is string {
  return typeof value === 'string';
}

function parseVirtualTime(value: unknown, errors: ImportReport['errors'], line: number):
  readonly VirtualTimeEvent[] | null {
  if (!Array.isArray(value)) {
    fail(errors, line, 'virtualTime 必须是数组');
    return null;
  }
  const out: VirtualTimeEvent[] = [];
  for (const [index, raw] of value.entries()) {
    if (
      !raw ||
      typeof raw !== 'object' ||
      !asFiniteNumber((raw as VirtualTimeEvent).atMs) ||
      !asString((raw as VirtualTimeEvent).kind) ||
      !asString((raw as VirtualTimeEvent).detail)
    ) {
      fail(errors, line, `virtualTime[${index}] 形状非法`);
      return null;
    }
    out.push({
      atMs: (raw as VirtualTimeEvent).atMs,
      kind: (raw as VirtualTimeEvent).kind,
      detail: (raw as VirtualTimeEvent).detail,
    });
  }
  return out;
}

function parseSchedule(value: unknown, errors: ImportReport['errors'], line: number):
  readonly ScheduleEvent[] | null {
  if (!Array.isArray(value)) {
    fail(errors, line, 'schedule 必须是数组');
    return null;
  }
  const out: ScheduleEvent[] = [];
  for (const [index, raw] of value.entries()) {
    const event = raw as ScheduleEvent;
    if (
      !raw ||
      typeof raw !== 'object' ||
      !Number.isInteger(event.seq) ||
      !asFiniteNumber(event.atMs) ||
      !asString(event.actor) ||
      !asString(event.action) ||
      !asString(event.resource)
    ) {
      fail(errors, line, `schedule[${index}] 形状非法`);
      return null;
    }
    out.push({
      seq: event.seq,
      atMs: event.atMs,
      actor: event.actor,
      action: event.action,
      resource: event.resource,
    });
  }
  return out;
}

function parseRun(raw: unknown, errors: ImportReport['errors'], line: number): RunRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(errors, line, '不是 JSON 对象');
    return null;
  }
  const record = raw as Partial<RunRecord>;
  if (!asString(record.testName)) {
    fail(errors, line, '缺少字符串字段 testName');
  }
  if (!Number.isInteger(record.exitStatus)) {
    fail(errors, line, '缺少整数字段 exitStatus');
  }
  if (!asString(record.stdoutSummary)) {
    fail(errors, line, '缺少字符串字段 stdoutSummary');
  }
  if (!asFiniteNumber(record.seed) || !Number.isInteger(record.seed)) {
    fail(errors, line, '缺少整数字段 seed');
  }
  if (!record.env || typeof record.env !== 'object' || Array.isArray(record.env)) {
    fail(errors, line, '缺少对象字段 env');
  } else {
    for (const [key, value] of Object.entries(record.env)) {
      if (!asString(value)) {
        fail(errors, line, `env.${key} 必须是字符串`);
      }
    }
  }
  const virtualTime = parseVirtualTime(record.virtualTime, errors, line);
  const schedule = parseSchedule(record.schedule, errors, line);
  if (!asFiniteNumber(record.durationMs)) {
    fail(errors, line, '缺少数字字段 durationMs');
  }
  if (
    !record.requirements ||
    typeof record.requirements !== 'object' ||
    !asString(record.requirements.platform) ||
    !asString(record.requirements.runtimeVersion) ||
    !Array.isArray(record.requirements.caps) ||
    record.requirements.caps.some((cap) => !asString(cap))
  ) {
    fail(errors, line, 'requirements 形状非法');
  }
  if (errors.some((entry) => entry.line === line)) {
    return null;
  }
  const safe = record as RunRecord;
  const id =
    asString(record.id) && record.id!.trim().length > 0
      ? record.id!.trim()
      : `run:${runFingerprint(safe).slice(0, 16)}`;
  const recordedAt = asString(record.recordedAt)
    ? record.recordedAt
    : new Date(Date.UTC(2026, 8, 22)).toISOString();
  return { ...safe, id, recordedAt };
}

/**
 * 解析 NDJSON 文本为运行记录。返回的记录保持文件中的行顺序；
 * 与已有记录的合并（指纹去重/冲突检测）由 mergeRuns 负责。
 */
export function parseNDJSON(
  text: string,
): { runs: RunRecord[]; report: ImportReport } {
  const errors: ImportReport['errors'] = [];
  const runs: RunRecord[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
 let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      fail(errors, index + 1, `JSON 解析失败：${(error as Error).message}`);
      return;
    }
    const run = parseRun(parsed, errors, index + 1);
    if (run) {
      runs.push(run);
    }
  });
  return {
    runs,
    report: { imported: 0, skippedDuplicates: 0, errors, fingerprintConflicts: [] },
  };
}

/**
 * 合并新记录到既有集合，保持追加顺序：
 * - 同指纹记录跳过（去重）；
 * - 同 id 但指纹不同属于冲突，拒绝并报告（防止指纹被“换皮”）。
 */
export function mergeRuns(
  existing: readonly RunRecord[],
  incoming: readonly RunRecord[],
): { runs: RunRecord[]; imported: number; skippedDuplicates: number; conflicts: string[] } {
  const byFingerprint = new Map(existing.map((run) => [runFingerprint(run), run.id]));
  const byId = new Map(existing.map((run) => [run.id, runFingerprint(run)]));
  const merged: RunRecord[] = [...existing];
  let imported = 0;
  let skippedDuplicates = 0;
  const conflicts: string[] = [];

  for (const run of incoming) {
    const fingerprint = runFingerprint(run);
    if (byFingerprint.has(fingerprint)) {
      skippedDuplicates += 1;
      continue;
    }
    const prior = byId.get(run.id);
    if (prior && prior !== fingerprint) {
      conflicts.push(run.id);
      continue;
    }
    merged.push(run);
    byFingerprint.set(fingerprint, run.id);
    byId.set(run.id, fingerprint);
    imported += 1;
  }
  return { runs: merged, imported, skippedDuplicates, conflicts };
}

export function makeExportBundle(
  runs: readonly RunRecord[],
  noisePolicy: ExportBundle['noisePolicy'],
  recipes: readonly ExportBundle['recipes'][number][],
  clusterViews: readonly ExportBundle['clusterViews'][number][],
  now: () => Date = () => new Date(),
): ExportBundle {
  return {
    format: 'flaky-replay-vault',
    formatVersion: 1,
    exportedAt: now().toISOString(),
    runs,
    noisePolicy,
    recipes,
    clusterViews,
  };
}

export function parseExportBundle(value: unknown): ExportBundle {
  if (!value || typeof value !== 'object') {
    throw new Error('导出包必须是对象');
  }
  const bundle = value as Partial<ExportBundle>;
  if (bundle.format !== 'flaky-replay-vault' || bundle.formatVersion !== 1) {
    throw new Error('导出包格式或版本不匹配');
  }
  if (!Array.isArray(bundle.runs)) {
    throw new Error('导出包缺少 runs 数组');
  }
  return bundle as ExportBundle;
}
