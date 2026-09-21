import type { NormalizeRule, RulePack } from './types';

/**
 * 内置归一化规则包。规则包不可变：发布新版本只会产生新的聚类视图，
 * 旧版本视图（以及其证据）保持可解释、可复算。
 *
 * 设计红线：这些规则绝不匹配
 *   - 错误类型（AssertionError / TimeoutError 等单词）
 *   - 文件行号（file.ts:42 中的数字后无时间单位）
 *   - 断言值（expected/received 后的普通数字）
 * 只替换带显式单位/格式的持续时间、地址、时间戳、线程号等噪声。
 */

const durationRule: NormalizeRule = {
  id: 'duration-with-unit',
  description: '把带显式时间单位的耗时数字替换为 <DUR>，不带单位的数字（如行号、断言值）保持不变',
  patternSource: '\\b\\d+(?:\\.\\d+)?\\s?(?:ms|sec|seconds?|minutes?|min)\\b',
  patternFlags: 'gi',
  replacement: '<DUR>',
};

const hexAddressRule: NormalizeRule = {
  id: 'hex-address',
  description: '把 0x 开头的内存地址替换为 <ADDR>',
  patternSource: '\\b0x[0-9a-fA-F]{6,}\\b',
  patternFlags: 'g',
  replacement: '<ADDR>',
};

const isoTimestampRule: NormalizeRule = {
  id: 'iso-timestamp',
  description: '把完整 ISO 8601 时间戳替换为 <TIME>',
  patternSource:
    '\\b\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})\\b',
  patternFlags: 'g',
  replacement: '<TIME>',
};

const threadIdRule: NormalizeRule = {
  id: 'thread-id',
  description: '把显式 thread-N / pid=N 形式的线程进程编号替换为 <TID>，不触碰 worker 名等调度主体',
  patternSource: '\\b(?:thread[\\s\\-/]?\\d+|pid[:=]\\d+)\\b',
  patternFlags: 'gi',
  replacement: '<TID>',
};

const PACK_V1: RulePack = {
  packId: 'builtin',
  packVersion: 1,
  description: 'v1：仅归一化持续时间与内存地址',
  rules: [durationRule, hexAddressRule],
};

const PACK_V2: RulePack = {
  packId: 'builtin',
  packVersion: 2,
  description: 'v2：在 v1 基础上新增 ISO 时间戳与线程号归一化（只生成新视图）',
  rules: [durationRule, hexAddressRule, isoTimestampRule, threadIdRule],
};

const PACKS: ReadonlyArray<RulePack> = [PACK_V1, PACK_V2];

export function getRulePack(packId: string, version: number): RulePack {
  const pack = PACKS.find((p) => p.packId === packId && p.packVersion === version);
  if (!pack) {
    throw new Error(`未知规则包：${packId}@v${version}`);
  }
  return pack;
}

export function listRulePacks(): readonly RulePack[] {
  return PACKS;
}

export const DEFAULT_PACK_ID = 'builtin';
export const DEFAULT_PACK_VERSION = 1;
