import type {
  NormalizerContext,
  NormalizedText,
  NormalizerRule,
  RuleTrace,
  Ruleset,
} from './types.js';

/**
 * 版本化归一化规则集。
 *
 * 关键纪律：
 *  - 规则只能消除使用者声明的“噪声”，绝不触碰行号、错误类型、断言期望值/实际值。
 *  - 规则一旦发布不可修改；新增噪声类型 ⇒ 新规则 ⇒ 新规则集版本 ⇒ 新聚类视图，
 *    旧版本的聚类视图原样保留。
 */

const PLACEHOLDER_TMP = '<TMP>';
const PLACEHOLDER_DUR = '<DUR>';
const PLACEHOLDER_TIME = '<TIME>';

const RULE_TEMP_PATHS_V1: NormalizerRule = {
  id: 'temp-paths-v1',
  introducedIn: 1,
  description:
    '把使用者声明的临时路径根，以及常见系统临时目录（/tmp、/var/folders/.../T、%TEMP%）替换为 <TMP>。' +
    '只替换目录前缀，保留相对路径、文件名以及 :行号:列号 后缀。',
};

const RULE_DURATION_NOISE_V1: NormalizerRule = {
  id: 'duration-noise-v1',
  introducedIn: 1,
  description:
    '把计时语境中的耗时数字（took/elapsed/duration/timeout/deadline 附近，以及非断言行上的 12ms/1.2s）替换为 <DUR>。' +
    '不触碰 :行号 形式的数字；包含 assert/expect/expected/actual 的断言行不做裸数字替换；错误类型与断言值保留。',
};

const RULE_WALLCLOCK_V2: NormalizerRule = {
  id: 'wallclock-iso8601-v2',
  introducedIn: 2,
  description:
    '把 ISO-8601 挂钟时间戳（2026-09-22T06:05:00.123Z）替换为 <TIME>。' +
    '不匹配 file:line:column，因此行号与列号保持不变。',
};

export const ALL_RULES: NormalizerRule[] = [
  RULE_TEMP_PATHS_V1,
  RULE_DURATION_NOISE_V1,
  RULE_WALLCLOCK_V2,
];

export function rulesForVersion(version: number): NormalizerRule[] {
  return ALL_RULES.filter((rule) => rule.introducedIn <= version);
}

export function getRuleset(version: number): Ruleset {
  const rules = rulesForVersion(version);
  return {
    version,
    rules,
    normalizeText: (input, ctx) => normalizeText(input, ctx, version),
  };
}

export const LATEST_RULESET_VERSION = Math.max(...ALL_RULES.map((r) => r.introducedIn));

interface Replacement {
  start: number;
  end: number;
  replacement: string;
  ruleId: string;
  before: string;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 找出使用者声明的临时根前缀的匹配（长前缀优先，避免短前缀遮蔽）。 */
function declaredTempReplacements(
  text: string,
  ctx: NormalizerContext,
): Replacement[] {
  const roots = [...new Set(ctx.tempPathRoots.filter((root) => root.length > 0))]
    .sort((a, b) => b.length - a.length);
  const out: Replacement[] = [];
  const claimed: Array<[number, number]> = [];
  for (const root of roots) {
    const re = new RegExp(escapeRegExp(root), 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const [start, end] = [match.index, match.index + match[0].length];
      if (claimed.some(([s, e]) => start < e && end > s)) {
        continue;
      }
      claimed.push([start, end]);
      out.push({
        start,
        end,
        replacement: PLACEHOLDER_TMP,
        ruleId: RULE_TEMP_PATHS_V1.id,
        before: match[0],
      });
    }
  }
  return out;
}

/** 常见系统临时目录的兜底匹配；只吃掉“会话目录”这一层，保留后续相对路径与行号。 */
const GENERIC_TMP_PATTERNS: RegExp[] = [
  // /tmp/pytest-of-<user>/<session>/<rel…>：只替换到会话目录，保留 <rel…>（含 :行:列）
  /(?:\/private)?\/tmp\/pytest-of-[^/\s:]+\/[^/\s:]+/g,
  // /private/tmp/<user>/<session>/<rel…>
  /\/private\/tmp\/[^/\s:]+\/[^/\s:]+/g,
  // /var/folders/<xx>/<long>/T/<session>/<rel…>
  /\/var\/folders\/[0-9a-z]{2}\/[0-9a-z-]{20,}\/T\/[^/\s:]+/gi,
  // /tmp/<session>/<rel…>（放在带前缀的模式之后）
  /(?:\/private)?\/tmp\/[^/\s:]+/g,
  /\/dev\/shm\/[^/\s:]+/g,
  /[A-Za-z]:\\Users\\[^\\\s:]+\\AppData\\Local\\Temp\\[^\\\s:]+/g,
];

function genericTempReplacements(text: string): Replacement[] {
  const out: Replacement[] = [];
  for (const re of GENERIC_TMP_PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      out.push({
        start: match.index,
        end: match.index + match[0].length,
        replacement: PLACEHOLDER_TMP,
        ruleId: RULE_TEMP_PATHS_V1.id,
        before: match[0],
      });
    }
  }
  return out;
}

const TIMING_KEYWORDS =
  'took|elapsed|duration|latency|waited|spent|timeout|deadline|after|elapsed_time|耗时|用时';

const ASSERTION_LINE = /assert|expect|expected|actual|operator|断言/i;

function durationReplacements(text: string): Replacement[] {
  const out: Replacement[] = [];
  const push = (start: number, end: number, before: string) => {
    out.push({
      start,
      end,
      replacement: PLACEHOLDER_DUR,
      ruleId: RULE_DURATION_NOISE_V1.id,
      before,
    });
  };

  // 1) 计时关键字紧邻的数值+单位：即使出现在断言行也属于耗时噪声（例如 "timeout after 123ms"）。
  const keywordThenDuration = new RegExp(
    `\\b(?:${TIMING_KEYWORDS})\\b[^\\d\\n]{0,24}?(\\d+(?:\\.\\d+)?)(ms|us|µs|ns|s)\\b`,
    'gi',
  );
  let match: RegExpExecArray | null;
  while ((match = keywordThenDuration.exec(text)) !== null) {
    push(match.index + match[0].length - match[1].length - match[2].length,
      match.index + match[0].length,
      `${match[1]}${match[2]}`);
  }

  // 2) 数值+单位紧邻计时词（"123ms elapsed" / "123 ms elapsed"）。
  const durationThenKeyword = new RegExp(
    `(\\d+(?:\\.\\d+)?)(ms|us|µs|ns|s)\\s{0,4}\\b(?:elapsed|duration|latency|耗时|用时)\\b`,
    'gi',
  );
  while ((match = durationThenKeyword.exec(text)) !== null) {
    push(match.index, match.index + match[1].length + match[2].length, match[0].slice(0, match[1].length + match[2].length));
  }

  // 3) 非断言行上的裸耗时（带单位，故不会命中 :行号）。
  for (const line of text.split('\n')) {
    if (ASSERTION_LINE.test(line)) {
      continue;
    }
    const bare = /\d+(?:\.\d+)?(?:ms|us|µs|ns)\b|\b\d+(?:\.\d+)?s\b/g;
    const offset = indexOfLine(text, line);
    let sub: RegExpExecArray | null;
    while ((sub = bare.exec(line)) !== null) {
      push(offset + sub.index, offset + sub.index + sub[0].length, sub[0]);
    }
  }
  return out;
}

function indexOfLine(haystack: string, line: string): number {
  return haystack.indexOf(line);
}

const ISO_8601 =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;

function wallclockReplacements(text: string): Replacement[] {
  const out: Replacement[] = [];
  let match: RegExpExecArray | null;
  while ((match = ISO_8601.exec(text)) !== null) {
    out.push({
      start: match.index,
      end: match.index + match[0].length,
      replacement: PLACEHOLDER_TIME,
      ruleId: RULE_WALLCLOCK_V2.id,
      before: match[0],
    });
  }
  return out;
}

const MAX_TRACES_PER_RULE = 20;

/** 归一化入口：声明临时路径 → 系统临时目录 → 耗时噪声 → （v2+）挂钟时间。 */
export function normalizeText(
  input: string,
  ctx: NormalizerContext,
  rulesetVersion: number,
): NormalizedText {
  let replacements: Replacement[] = declaredTempReplacements(input, ctx);

  const addNonOverlapping = (found: Replacement[]) => {
    for (const rep of found) {
      if (
        replacements.some((r) => rep.start < r.end && rep.end > r.start)
      ) {
        continue;
      }
      replacements.push(rep);
    }
  };

  addNonOverlapping(genericTempReplacements(input));
  addNonOverlapping(durationReplacements(input));
  if (rulesetVersion >= 2) {
    addNonOverlapping(wallclockReplacements(input));
  }

  replacements = replacements.sort((a, b) => a.start - b.start || a.end - b.end);

  let out = '';
  let cursor = 0;
  const traces: RuleTrace[] = [];
  const perRuleCount: Record<string, number> = {};
  for (const rep of replacements) {
    if (rep.start < cursor) {
      continue; // 排序后仍然重叠时，保留更早的规则
    }
    out += input.slice(cursor, rep.start) + rep.replacement;
    cursor = rep.end;
    const count = perRuleCount[rep.ruleId] ?? 0;
    if (count < MAX_TRACES_PER_RULE) {
      traces.push({
        ruleId: rep.ruleId,
        index: out.length - rep.replacement.length,
        before: rep.before,
        after: rep.replacement,
      });
    }
    perRuleCount[rep.ruleId] = count + 1;
  }
  out += input.slice(cursor);
  return { text: out, traces, ruleHits: perRuleCount };
}
