import { describe, expect, it } from 'vitest';
import { getRuleset, normalizeText, LATEST_RULESET_VERSION } from '../src/core/normalizer.js';

const ctx = { tempPathRoots: ['/var/folders/9x/zzzzzzzzzzzzzzzzzzzzzz/T/pytest-of-ci/abc123'] };

describe('归一化噪声规则', () => {
  it('替换使用者声明的临时路径，但保留相对路径与行号', () => {
    const input = 'artifact /var/folders/9x/zzzzzzzzzzzzzzzzzzzzzz/T/pytest-of-ci/abc123/trace.json:7:2 boom';
    const result = normalizeText(input, ctx, 1);
    expect(result.text).toBe('artifact <TMP>/trace.json:7:2 boom');
  });

  it('兜底识别 /tmp/<user>/<session>、/tmp/<session> 与 /private/tmp 形式，且不吃掉后续路径与行号', () => {
    const result = normalizeText(
      'scratch: /tmp/pytest-of-me/sess-xyz/jobs.json:42 /private/tmp/ci9/sess2/out.log:9 /tmp/sess3/j.json:1',
      { tempPathRoots: [] },
      1,
    );
    expect(result.text).toBe('scratch: <TMP>/jobs.json:42 <TMP>/out.log:9 <TMP>/j.json:1');
  });

  it('耗时噪声：计时语境中的数字归一化为 <DUR>', () => {
    const result = normalizeText('request took 1842ms then failed', { tempPathRoots: [] }, 1);
    expect(result.text).toBe('request took <DUR> then failed');
  });

  it('行号永远不被当作耗时或时间戳吞掉', () => {
    const result = normalizeText('at tests/queue_test.ts:42', { tempPathRoots: [] }, 1);
    expect(result.text).toBe('at tests/queue_test.ts:42');
  });

  it('断言行上的裸耗时不被替换；错误类型与断言 expected/actual 原样保留', () => {
    const line = '  actual:   observedMs == 70';
    const result = normalizeText(line, { tempPathRoots: [] }, 1);
    expect(result.text).toBe(line);

    const assertion = 'assert deepEqual expected alpha,beta actual beta,beta';
    const assertionResult = normalizeText(assertion, { tempPathRoots: [] }, 1);
    expect(assertionResult.text).toBe(assertion);
  });

  it('v2 新增 ISO 时间戳归一化，v1 不动它；且不匹配 file:line:column', () => {
    const input = '2026-09-21T08:44:02.005Z at tests/x.ts:12:3';
    const v1 = normalizeText(input, { tempPathRoots: [] }, 1);
    expect(v1.text).toContain('2026-09-21T08:44:02.005Z');
    expect(v1.text).toContain('tests/x.ts:12:3');

    const v2 = normalizeText(input, { tempPathRoots: [] }, 2);
    expect(v2.text).toBe('<TIME> at tests/x.ts:12:3');
  });

  it('规则带有版本元数据且可枚举', () => {
    const v1 = getRuleset(1);
    expect(v1.rules.map((rule) => rule.id)).toEqual(['temp-paths-v1', 'duration-noise-v1']);
    const v2 = getRuleset(2);
    expect(v2.rules.map((rule) => rule.id)).toContain('wallclock-iso8601-v2');
    expect(LATEST_RULESET_VERSION).toBeGreaterThanOrEqual(2);
  });

  it('归一化结果带规则命中证据与真实命中次数', () => {
    const result = normalizeText('took 10ms, took 20ms', { tempPathRoots: [] }, 1);
    expect(result.ruleHits['duration-noise-v1']).toBe(2);
    expect(result.traces.every((trace) => trace.ruleId === 'duration-noise-v1')).toBe(true);
  });
});
