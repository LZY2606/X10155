import { sha256Hex } from "./fingerprint.js";
import type {
  NormalizedFailure,
  RuleApplication,
} from "./types.js";

export interface NormalizationContext {
  tempPaths: string[];
}

export interface NormalizationRule {
  id: string;
  sinceVersion: number;
  description: string;
  apply(
    input: string,
    ctx: NormalizationContext,
  ): { output: string; replacements: number };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const tempPathRule: NormalizationRule = {
  id: "declared-temp-paths",
  sinceVersion: 1,
  description: "将用户声明的临时路径（及其子路径）替换为 <TMP>",
  apply(input, ctx) {
    let output = input;
    let replacements = 0;
    for (const declared of ctx.tempPaths) {
      if (!declared) continue;
      const re = new RegExp(escapeRegExp(declared) + "[^\\s\"']*", "g");
      output = output.replace(re, () => {
        replacements += 1;
        return "<TMP>";
      });
    }
    return { output, replacements };
  },
};

const durationRule: NormalizationRule = {
  id: "duration-noise",
  sinceVersion: 1,
  description: "将持续时间（如 183ms、1.2s、3 seconds）替换为 <DURATION>",
  apply(input) {
    let replacements = 0;
    const re =
      /\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|secs?|seconds?|minutes?)\b/g;
    const output = input.replace(re, () => {
      replacements += 1;
      return "<DURATION>";
    });
    return { output, replacements };
  },
};

const pointerRule: NormalizationRule = {
  id: "pointer-address",
  sinceVersion: 2,
  description: "将十六进制指针地址（0x...）替换为 <ADDR>（v2 新增）",
  apply(input) {
    let replacements = 0;
    const output = input.replace(/\b0x[0-9a-fA-F]+\b/g, () => {
      replacements += 1;
      return "<ADDR>";
    });
    return { output, replacements };
  },
};

const ALL_RULES: NormalizationRule[] = [tempPathRule, durationRule, pointerRule];

export const CURRENT_RULE_VERSION = 2;
export const RULE_SET_VERSIONS = [1, 2];

export function rulesForVersion(version: number): NormalizationRule[] {
  return ALL_RULES.filter((r) => r.sinceVersion <= version);
}

export function extractErrorType(normalized: string): string | null {
  const m = normalized.match(/\b[A-Za-z]*(?:Error|Exception|AssertionFailure)\b/);
  return m ? m[0] : null;
}

export function normalizeFailureOutput(
  stdout: string,
  ctx: NormalizationContext,
  version: number = CURRENT_RULE_VERSION,
): NormalizedFailure {
  let text = stdout;
  const appliedRules: RuleApplication[] = [];
  for (const rule of rulesForVersion(version)) {
    const { output, replacements } = rule.apply(text, ctx);
    text = output;
    appliedRules.push({
      ruleId: rule.id,
      ruleVersion: rule.sinceVersion,
      description: rule.description,
      replacements,
    });
  }
  const errorType = extractErrorType(text);
  const signature = sha256Hex(`v${version}\n${errorType ?? ""}\n${text}`);
  return { normalized: text, errorType, appliedRules, signature, ruleVersion: version };
}
