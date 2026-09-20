import type {
  NormalizedText,
  RuleExplanation,
  RuleVersion,
  TestRun,
  FailureSignature,
} from "./types";
import { sha256 } from "./canonical";

interface Rule {
  id: string;
  version: RuleVersion;
  description: string;
  apply: (text: string, ctx: NormalizeContext) => { text: string; hits: number };
}

interface NormalizeContext {
  tempRoots: string[];
}

function replaceAll(text: string, pattern: RegExp, replacement: string) {
  const matches = text.match(pattern);
  if (!matches) return { text, hits: 0 };
  return { text: text.replace(pattern, replacement), hits: matches.length };
}

/**
 * Rule registry. Rules are immutable once shipped: changing them produces a
 * new ruleVersion and therefore new cluster *views*, never a rewrite of old
 * views.
 */
const RULES: Rule[] = [
  {
    id: "temp-declared-root",
    version: "v1",
    description:
      "将使用者声明的临时目录根（tempRoots）整体替换为 <TMPROOT>，保留根之后的相对结构。",
    apply(text, ctx) {
      let hits = 0;
      let next = text;
      for (const root of ctx.tempRoots) {
        if (!root) continue;
        const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // The whole path under the declared temp root is noise, including the
        // generated file name; the rule deliberately stops at whitespace.
        const pattern = new RegExp(escaped + "(?:/[^\\s:'\"]*)?", "g");
        const result = next.match(pattern);
        if (result) {
          hits += result.length;
          next = next.replace(pattern, "<TMPROOT>");
        }
      }
      return { text: next, hits };
    },
  },
  {
    id: "posix-tmp-path",
    version: "v1",
    description:
      "折叠系统临时目录路径形态（/tmp、/var/folders/...、$TMPDIR 形态），但不改动其中的行号。",
    apply(text) {
      const pattern =
        /(?:\/var\/folders\/[^\s:'"]+|\/tmp(?:\/[^\s:'"]*)?|\/private\/tmp(?:\/[^\s:'"]*)?)/g;
      return replaceAll(text, pattern, "<TMPPATH>");
    },
  },
  {
    id: "duration-ms",
    version: "v1",
    description:
      "折叠显式耗时表述（took/elapsed/duration/latency/waited/in + 时间，或 elapsed=12ms）；" +
      "不带耗时关键词的裸数值（如 expected 4ms 这类断言值）保持不变。",
    apply(text) {
      const pattern =
        /(\b(?:took|elapsed|duration|latency|waited|in)[\s=]*)(\d+(?:\.\d+)?\s*(?:ms|us|µs|ns|s))\b/gi;
      const matches = text.match(pattern);
      if (!matches) return { text, hits: 0 };
      return {
        text: text.replace(pattern, "$1<DURATION>"),
        hits: matches.length,
      };
    },
  },
  {
    id: "hex-address",
    version: "v1",
    description: "折叠 0x 开头的内存地址/指针值；普通行号与断言数值不受影响。",
    apply(text) {
      return replaceAll(text, /\b0x[0-9a-fA-F]+\b/g, "<ADDR>");
    },
  },
  {
    id: "pid-v2",
    version: "v2",
    description: "v2 新增：折叠 pid=1234 / [pid 1234] 形态的进程号。",
    apply(text) {
      const pattern = /(\bpid[=\s:]+)\d+\b/gi;
      const matches = text.match(pattern);
      if (!matches) return { text, hits: 0 };
      return { text: text.replace(pattern, "$1<PID>"), hits: matches.length };
    },
  },
  {
    id: "uuid-v2",
    version: "v2",
    description: "v2 新增：折叠 8-4-4-4-12 形态的 UUID。",
    apply(text) {
      return replaceAll(
        text,
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        "<UUID>",
      );
    },
  },
];

/**
 * What normalization deliberately does NOT touch:
 * - file:line references (line numbers kept, e.g. timer_test.ts:42)
 * - error type tokens (AssertionError, TimeoutError, ...)
 * - assertion values (expected 1, got 2 style payloads)
 * The rules above only match path/duration/address/pid/uuid noise shapes.
 */
export function normalizeSummary(
  text: string,
  ruleVersion: RuleVersion,
  tempRoots: string[] = [],
): NormalizedText {
  const active = activeRules(ruleVersion);
  const ruleHits: Record<string, number> = {};
  let current = text;
  for (const rule of active) {
    const { text: next, hits } = rule.apply(current, {
      tempRoots: [...tempRoots].sort().reverse(),
    });
    current = next;
    ruleHits[rule.id] = hits;
  }
  return { text: current, ruleHits };
}

export function activeRules(ruleVersion: RuleVersion): Rule[] {
  const order: RuleVersion[] = ["v1", "v2"];
  const cutoff = order.indexOf(ruleVersion);
  return RULES.filter((rule) => order.indexOf(rule.version) <= cutoff);
}

export function explainRules(
  ruleVersion: RuleVersion,
  ruleHits: Record<string, number>,
): RuleExplanation[] {
  return activeRules(ruleVersion).map((rule) => ({
    id: rule.id,
    version: rule.version,
    description: rule.description,
    hits: ruleHits[rule.id] ?? 0,
  }));
}

export function failureSignature(run: TestRun, ruleVersion: RuleVersion): FailureSignature {
  const normalized = normalizeSummary(
    run.stdoutSummary,
    ruleVersion,
    run.tempRoots ?? [],
  );
  const errorType = run.errorType ?? "";
  const signatureInput = [
    run.testName,
    errorType,
    String(run.exitCode),
    normalized.text,
  ].join("\u0000");
  return {
    testName: run.testName,
    errorType,
    signature: sha256(signatureInput),
    normalizedSummary: normalized.text,
    ruleVersion,
    ruleExplanations: explainRules(ruleVersion, normalized.ruleHits),
  };
}
