import type { NormalizationRule, Ruleset, RunRecord } from './types.js';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * declared-temp-paths v1：只归一化用户在运行记录中显式声明的临时路径。
 * 行号、错误类型、断言值一律保留。
 */
const declaredTempPathsV1: NormalizationRule = {
  id: 'declared-temp-paths',
  version: 1,
  description: '将用户声明的临时路径替换为 <TEMP_PATH>（精确匹配，最长优先）',
  apply(input, run) {
    let output = input;
    let replacements = 0;
    const paths = [...run.declaredTempPaths].sort((a, b) => b.length - a.length);
    for (const p of paths) {
      if (!p) continue;
      const re = new RegExp(escapeRegExp(p), 'g');
      output = output.replace(re, () => {
        replacements += 1;
        return '<TEMP_PATH>';
      });
    }
    return { output, replacements };
  },
};

/**
 * declared-temp-paths v2：在 v1 基础上，额外归一化常见的未声明临时目录路径。
 * 这是更激进的新版本规则 —— 只生成新的聚类视图，不改写 v1 的结果。
 */
const declaredTempPathsV2: NormalizationRule = {
  id: 'declared-temp-paths',
  version: 2,
  description:
    'v1 规则 + 归一化未声明的 /tmp、/var/tmp、/var/folders 等临时路径',
  apply(input, run) {
    const first = declaredTempPathsV1.apply(input, run);
    let replacements = first.replacements;
    const generic =
      /(?:\/private)?\/(?:tmp|var\/tmp|var\/folders\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)\/[^\s"']+/g;
    const output = first.output.replace(generic, () => {
      replacements += 1;
      return '<TEMP_PATH>';
    });
    return { output, replacements };
  },
};

/**
 * duration-noise v1：归一化 “123ms” / “1.5s” 等持续时间。
 * 必须带时间单位，绝不吞掉断言值里的裸数字。
 */
const durationNoiseV1: NormalizationRule = {
  id: 'duration-noise',
  version: 1,
  description: '将带单位的持续时间（123ms / 1.5s）替换为 <DURATION>',
  apply(input) {
    let replacements = 0;
    const output = input.replace(
      /\b\d+(?:\.\d+)?\s?(?:ms|milliseconds?|s|sec|seconds?|minutes?)\b/g,
      () => {
        replacements += 1;
        return '<DURATION>';
      },
    );
    return { output, replacements };
  },
};

/**
 * duration-noise v2：额外归一化 “took 123” / “in 42” 这类上下文型持续时间。
 */
const durationNoiseV2: NormalizationRule = {
  id: 'duration-noise',
  version: 2,
  description: 'v1 规则 + 归一化 “took N / in N” 上下文中的持续时间数字',
  apply(input) {
    const first = durationNoiseV1.apply(input);
    let replacements = first.replacements;
    const output = first.output.replace(
      /\b(?:took|in|after|elapsed)\s+(\d+(?:\.\d+)?)\b/gi,
      (whole) => {
        replacements += 1;
        return whole.replace(/\d+(?:\.\d+)?/, '<DURATION>');
      },
    );
    return { output, replacements };
  },
};

export const RULESETS: Ruleset[] = [
  {
    version: 'v1',
    rules: [declaredTempPathsV1, durationNoiseV1],
  },
  {
    version: 'v2',
    rules: [declaredTempPathsV2, durationNoiseV2],
  },
];

export const DEFAULT_RULESET_VERSION = 'v2';

export function getRuleset(version: string): Ruleset | undefined {
  return RULESETS.find((r) => r.version === version);
}

export function rulesetVersions(): string[] {
  return RULESETS.map((r) => r.version);
}
