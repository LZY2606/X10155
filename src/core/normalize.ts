import { fallbackHash } from './fingerprint';
import { extractFailureText } from './failure';
import { getRulePack } from './rulePacks';
import type {
  FailureSignature,
  NoisePolicy,
  RuleHit,
  RunRecord,
  SignatureEvidence,
} from './types';

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 归一化失败文本并保留完整证据：
 * 1) 用户声明的临时路径（整条路径替换为 <TMP>，根按长度降序避免前缀互相覆盖）；
 * 2) 规则包内的版本化规则，逐条全局替换并记录命中。
 */
export function normalizeFailureText(
  rawText: string,
  policy: NoisePolicy,
): { normalized: string; evidence: Omit<SignatureEvidence, 'rawFailureText'> } {
  const pack = getRulePack(policy.packId, policy.packVersion);
  let text = rawText;
  const tempHits: SignatureEvidence['tempHits'] = [];

  const roots = [...policy.tempRoots]
    .filter((root) => root.length > 0)
    .sort((a, b) => b.length - a.length);

  for (const root of roots) {
    const pattern = new RegExp(
      `${escapeRegExp(root)}(?:[/\\\\][^\\s:"')\\]]*)?`,
      'g',
    );
    text = text.replace(pattern, (matched, index: number) => {
      if (matched === root) {
        return matched;
      }
      tempHits.push({ root, matched, index });
      return '<TMP>';
    });
  }

  const ruleHits: RuleHit[] = [];
  for (const rule of pack.rules) {
    const pattern = new RegExp(rule.patternSource, rule.patternFlags);
    text = text.replace(pattern, (matched, index: number) => {
      ruleHits.push({ ruleId: rule.id, matched, index, replacement: rule.replacement });
      return rule.replacement;
    });
  }

  return {
    normalized: text,
    evidence: {
      normalizedText: text,
      tempHits,
      ruleHits,
      packId: pack.packId,
      packVersion: pack.packVersion,
      policyVersion: policy.policyVersion,
    },
  };
}

/**
 * 计算失败签名。测试名参与签名：不同测试的相似错误不会被聚到一起。
 * 行号、错误类型、断言值保留在归一化文本中，其变化必然改变签名。
 */
export function signatureForRun(
  run: RunRecord,
  policy: NoisePolicy,
): FailureSignature | null {
  const raw = extractFailureText(run);
  if (raw === null) {
    return null;
  }
  const { normalized, evidence } = normalizeFailureText(raw, policy);
  const signature = fallbackHash(
    JSON.stringify({
      testName: run.testName.split(' > ')[0]!.trim(),
      normalized,
      pack: `${policy.packId}@${policy.packVersion}`,
      policy: policy.policyVersion,
    }),
  );
  return {
    signature,
    evidence: { rawFailureText: raw, ...evidence },
  };
}
