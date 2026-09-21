import { canonicalJson } from './canonical.js';
import { fnv1a64Hex } from './hash.js';
import { getRuleset, LATEST_RULESET_VERSION } from './normalizer.js';
import type {
  FailureSignature,
  NormalizerContext,
  RuleTrace,
  RunRecord,
} from './types.js';

export const SIGNATURE_SCHEME = 'fail-sig-v1';
const MAX_TRACE_SAMPLES = 40;

/**
 * 失败签名的载荷纪律：
 *  - 纳入：测试名、退出状态、归一化后的输出、结构化错误（含行号与断言值）、
 *    虚拟时间事件的“种类与细节”（细节文本归一化）。
 *  - 刻意排除：startedAt / durationMs（挂钟与持续时间噪声），
 *    以及调度决策本身（不同调度轨迹可能是同一缺陷的触发方式，
 *    调度轨迹是重放配方要固定的东西，而不是失败形态）。
 */
export function signatureForRun(
  run: RunRecord,
  rulesetVersion: number = LATEST_RULESET_VERSION,
): FailureSignature {
  const ruleset = getRuleset(rulesetVersion);
  const ctx: NormalizerContext = { tempPathRoots: run.tempPathRoots ?? [] };

  const stdout = ruleset.normalizeText(run.stdoutSummary, ctx);
  const stderr = ruleset.normalizeText(run.stderrSummary, ctx);

  const normalizedError = run.error
    ? {
        type: run.error.type,
        message: ruleset.normalizeText(run.error.message, ctx).text,
        file: run.error.file ? ruleset.normalizeText(run.error.file, ctx).text : undefined,
        line: run.error.line,
        column: run.error.column,
        assertion: run.error.assertion
          ? {
              expected: run.error.assertion.expected,
              actual: run.error.assertion.actual,
              operator: run.error.assertion.operator,
            }
          : undefined,
      }
    : null;

  const virtualEvents = run.virtualTimeEvents.map((event) => ({
    kind: event.kind,
    detail: Object.fromEntries(
      Object.entries(event.detail ?? {}).map(([key, value]) => [
        key,
        typeof value === 'string' ? ruleset.normalizeText(value, ctx).text : value,
      ]),
    ),
  }));

  const payload = {
    scheme: SIGNATURE_SCHEME,
    testName: run.testName,
    exitStatus: run.exitStatus,
    stdout: stdout.text,
    stderr: stderr.text,
    error: normalizedError,
    virtualTimeEvents: virtualEvents,
  };

  const canonical = canonicalJson(payload);
  const traces = mergeTraceSamples([stdout, stderr]);

  return {
    scheme: `${SIGNATURE_SCHEME}+rules-v${rulesetVersion}`,
    rulesetVersion,
    hash: fnv1a64Hex(canonical),
    canonical,
    traces,
  };
}

function mergeTraceSamples(texts: Array<{ traces: RuleTrace[] }>): RuleTrace[] {
  const out: RuleTrace[] = [];
  const counts: Record<string, number> = {};
  for (const part of texts) {
    for (const trace of part.traces) {
      const seen = counts[trace.ruleId] ?? 0;
      if (seen < MAX_TRACE_SAMPLES) {
        out.push(trace);
      }
      counts[trace.ruleId] = seen + 1;
    }
  }
  return out;
}
