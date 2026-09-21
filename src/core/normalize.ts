import type {
  FailureSignature,
  NormalizedText,
  NormalizationTransform,
  RuleVersion,
  RunRecord,
} from "./types.js";

/**
 * 规则只做“声明过的噪声”归一化：
 *  - 用户声明的临时路径前缀
 *  - 形如 "12.3 ms/seconds" 的持续时间噪声
 * 绝不触碰行号、错误类型、断言值——这些必须原样留在签名里。
 */

export interface NormalizerRule {
  id: string;
  description: string;
  /** 基于记录构造替换：(原文) -> [命中片段, 替换串] 的迭代器。 */
  find: (text: string, run: RunRecord) => { matches: string[]; replace: RegExp };
  replacement: string;
}

export interface RuleSet {
  version: RuleVersion;
  description: string;
  /** 规则按顺序应用，顺序是规则定义的一部分。 */
  rules: NormalizerRule[];
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 用户声明的临时路径前缀：只有声明过的前缀才会被遮蔽。
 * 前缀下一层的种子派生目录（worker-<digits> / case-<digits>）同属路径噪声，
 * 但再往后的文件名（drain.log）保留，行号、断言值一律不动。
 */
const tempPathsRule: NormalizerRule = {
  id: "declared-temp-paths",
  description:
    "遮蔽声明临时路径前缀及其下一层种子派生目录（worker-<digits>/case-<digits>），保留文件名",
  replacement: "<TEMP>",
  find(text, run) {
    const prefixes = [...(run.tempPathPrefixes ?? [])]
      .filter((prefix) => prefix.length > 0)
      .sort((a, b) => b.length - a.length);
    if (prefixes.length === 0) {
      return { matches: [], replace: /(?!)/g };
    }
    const group = prefixes.map(escapeRegExp).join("|");
    // 两遍替换：先吃“前缀 + 种子派生目录”的长路径，再遮蔽裸前缀。
    // JS 正则交替在同一起始位置取最先可匹配的分支，所以不能用单个交替表达式。
    const longPattern = new RegExp(`(?:${group})/(?:worker|case)-\d+`, "g");
    const barePattern = new RegExp(group, "g");
    const matches = [...(text.match(longPattern) ?? []), ...(text.match(barePattern) ?? [])];
    const replace = new RegExp(`(?:${group})/(?:worker|case)-\d+|${group}`, "g");
    // 上面的交替仍受“先匹配优先”影响，因此 find 的消费者需要按顺序应用两条规则；
    // 这里用自定义替换器：先替换长路径，再在结果上替换裸前缀。
    return {
      matches,
      replace: {
        [Symbol.replace](input: string, repl: string): string {
          // 长路径先替换；替换后裸前缀已不存在于那些位置，第二遍只处理裸前缀。
          return input.replace(longPattern, repl).replace(barePattern, repl);
        },
      } as unknown as RegExp,
    };
  },
};

/** 持续时间：要求带时间单位，避免把裸数字（行号、断言值）误吞。 */
const durationRule: NormalizerRule = {
  id: "duration-with-unit",
  description: "归一化带时间单位的持续时间数值（ms/s/seconds），不触碰裸数字",
  replacement: "<DURATION>",
  find(text) {
    const re = /\b\d+(?:\.\d+)?\s?(?:ms|msecs?|milliseconds?|s|secs?|seconds?)\b/gi;
    return { matches: text.match(re) ?? [], replace: re };
  },
};


/** 复现参数种子：形如 seed=11 的记录噪声；断言值在独立的 values: 行，不受影响。 */
const seedParamRule: NormalizerRule = {
  id: "recorded-seed-parameter",
  description: "归一化输出中记录的 seed= 参数值（种子本身仍由配方固定）",
  replacement: "<SEED>",
  find(text) {
    const re = /\bseed=-?\d+\b/g;
    return { matches: text.match(re) ?? [], replace: re };
  },
};

/** v2 追加：进程/线程标识这类环境噪声（v1 视图保持不变，不重算语义）。 */
const pidRule: NormalizerRule = {
  id: "process-thread-id",
  description: "归一化形如 pid=12345 / tid 99 的进程与线程标识",
  replacement: "<PID>",
  find(text) {
    const re = /\b(?:pid|tid|process(?:-?id)?)\s*[=:]\s*\d+\b/gi;
    return { matches: text.match(re) ?? [], replace: re };
  },
};

/** v2 追加：十六进制指针地址噪声，绝不影响十进制断言值与行号。 */
const pointerRule: NormalizerRule = {
  id: "hex-address",
  description: "归一化 0x 开头的指针地址；十进制断言值与行号保持原样",
  replacement: "<ADDR>",
  find(text) {
    const re = /\b0x[0-9a-f]+\b/gi;
    return { matches: text.match(re) ?? [], replace: re };
  },
};

export const RULE_SETS: Record<RuleVersion, RuleSet> = {
  "rules-v1": {
    version: "rules-v1",
    description: "声明临时路径 + 带单位持续时间 + seed 参数",
    rules: [tempPathsRule, durationRule, seedParamRule],
  },
  "rules-v2": {
    version: "rules-v2",
    description: "v1 + 进程/线程标识 + 十六进制地址",
    rules: [tempPathsRule, durationRule, pidRule, pointerRule],
  },
};

export const DEFAULT_RULE_VERSION: RuleVersion = "rules-v1";
export const RULE_VERSIONS: RuleVersion[] = ["rules-v1", "rules-v2"];

/** 应用单个规则集，保留每一步的变换证据；无命中不产生变换记录。 */
export function normalizeText(text: string, run: RunRecord, version: RuleVersion): NormalizedText {
  const ruleSet = RULE_SETS[version];
  if (!ruleSet) throw new Error(`未知的归一化规则版本: ${version}`);
  let current = text;
  const transforms: NormalizationTransform[] = [];
  for (const rule of ruleSet.rules) {
    const { matches, replace } = rule.find(current, run);
    if (matches.length > 0) {
      transforms.push({
        ruleId: rule.id,
        description: rule.description,
        matches: [...new Set(matches)],
        replacement: rule.replacement,
      });
      current = current.replace(replace, rule.replacement);
    }
  }
  return { text: current, ruleVersion: version, transforms };
}

/** 稳定哈希：FNV-1a 64 位十六进制，纯函数、跨运行/跨进程一致。 */
export function stableHash(input: string): string {
  let hi = 0x811c9dc5;
  let lo = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    lo ^= code;
    lo = Math.imul(lo, 0x01000193) >>> 0;
    hi ^= code;
    hi = Math.imul(hi, 0x01000193) >>> 0;
    // 混合高低 32 位，避免短串哈希只落在低位。
    hi = (hi + Math.imul(lo, 0x9e3779b1)) >>> 0;
  }
  return `fnv-${(hi >>> 0).toString(16).padStart(8, "0")}${(lo >>> 0).toString(16).padStart(8, "0")}`;
}

/** 失败文本：stdout 与 stderr 摘要合并，空 stderr 不影响。 */
function failureText(run: RunRecord): string {
  return [run.stdoutSummary ?? "", run.stderrSummary ?? ""].filter(Boolean).join("\n").trim();
}

export function buildSignature(run: RunRecord, version: RuleVersion): FailureSignature {
  const normalized = normalizeText(failureText(run), run, version);
  const signatureHash = stableHash(
    [version, run.testName, run.status, normalized.text].join("\u0000"),
  );
  return {
    ruleVersion: version,
    testName: run.testName,
    status: run.status,
    normalizedSummary: normalized.text,
    normalization: normalized,
    signatureHash,
  };
}

/** 运行指纹：规范化所有字段后哈希；原始运行因此可去重且指纹稳定。 */
export function runFingerprint(run: RunRecord): string {
  const canonical = JSON.stringify({
    testName: run.testName,
    status: run.status,
    exitCode: run.exitCode,
    stdoutSummary: run.stdoutSummary ?? "",
    stderrSummary: run.stderrSummary ?? "",
    seed: run.seed ?? null,
    env: sortedObject(run.env ?? {}),
    tempPathPrefixes: [...(run.tempPathPrefixes ?? [])].sort(),
    durationMs: run.durationMs ?? null,
    virtualTime: run.virtualTime ?? [],
    schedule: run.schedule ?? [],
  });
  return `run-${stableHash(canonical)}`;
}

function sortedObject(obj: Record<string, string>): Array<[string, string]> {
  return Object.keys(obj)
    .sort()
    .map((key) => [key, obj[key] ?? ""]);
}
