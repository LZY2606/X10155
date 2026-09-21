import { runFingerprint } from './fingerprint.js';
import { getRuleset } from './normalizer.js';
import { signatureForRun } from './signature.js';
import type { Cluster, ClusterView, RunRecord } from './types.js';

/**
 * 按失败签名聚类。
 *
 *  - 仅对退出状态非 0 的运行聚类；通过的运行保留但不进聚类。
 *  - 聚类成员是运行指纹，顺序严格遵循 runOrder（首次导入顺序），可重复、可稳定比较。
 *  - 每次聚类都重新计算（纯函数），因此规则版本升级只产生新视图，绝不改写旧视图。
 */
export function buildClusterView(
  runs: RunRecord[],
  rulesetVersion: number,
): ClusterView {
  const ruleset = getRuleset(rulesetVersion);
  const byHash = new Map<string, Cluster>();

  for (const run of runs) {
    if (run.exitStatus === 0) {
      continue;
    }
    const signature = signatureForRun(run, rulesetVersion);
    let cluster = byHash.get(signature.hash);
    if (!cluster) {
      cluster = {
        id: `rules${rulesetVersion}:${signature.hash}`,
        testName: run.testName,
        signature,
        members: [],
        ruleUsage: {},
      };
      byHash.set(signature.hash, cluster);
    }
    cluster.members.push(runFingerprint(run));

    // 规则命中次数用于在 UI 中解释“这个聚类用了哪些归一化规则”。
    for (const field of [run.stdoutSummary, run.stderrSummary, run.error?.message, run.error?.file]) {
      if (typeof field !== 'string') {
        continue;
      }
      const normalized = ruleset.normalizeText(field, {
        tempPathRoots: run.tempPathRoots ?? [],
      });
      for (const [ruleId, hits] of Object.entries(normalized.ruleHits)) {
        cluster.ruleUsage[ruleId] = (cluster.ruleUsage[ruleId] ?? 0) + hits;
      }
    }
  }

  const clusters = [...byHash.values()].sort((a, b) => {
    const byName = a.testName < b.testName ? -1 : a.testName > b.testName ? 1 : 0;
    if (byName !== 0) {
      return byName;
    }
    return a.signature.hash < b.signature.hash ? -1 : 1;
  });

  return { rulesetVersion, clusters };
}
