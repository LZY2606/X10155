import { canonicalJson, sha256 } from './hash.js';
import type { FailureSignature, Ruleset, RunRecord } from './types.js';

/**
 * 计算失败签名：对 stdout 摘要依次应用规则集中的归一化规则，
 * 然后连同测试名与退出状态一起哈希。原始运行记录始终保留，
 * 签名里逐条记录规则应用情况，保证聚类可解释。
 */
export function computeSignature(run: RunRecord, ruleset: Ruleset): FailureSignature {
  let normalized = run.stdout;
  const appliedRules = [];
  for (const rule of ruleset.rules) {
    const { output, replacements } = rule.apply(normalized, run);
    normalized = output;
    appliedRules.push({ ruleId: rule.id, version: rule.version, replacements });
  }
  const hash = sha256(
    canonicalJson({
      rulesetVersion: ruleset.version,
      testName: run.testName,
      exitStatus: run.exitStatus,
      normalizedStdout: normalized,
    }),
  );
  return {
    hash,
    testName: run.testName,
    exitStatus: run.exitStatus,
    normalizedStdout: normalized,
    rulesetVersion: ruleset.version,
    appliedRules,
  };
}
