import { computeSignature } from './signature.js';
import type { Cluster, Ruleset, StoredRun } from './types.js';

/**
 * 按失败签名聚类。成员顺序 = 运行导入顺序（seq），保证
 * 导出/再导入后聚类成员顺序稳定。原始运行不被修改。
 */
export function clusterRuns(runs: StoredRun[], ruleset: Ruleset): Cluster[] {
  const sorted = [...runs].sort((a, b) => a.seq - b.seq);
  const byHash = new Map<string, Cluster>();
  for (const run of sorted) {
    const signature = computeSignature(run, ruleset);
    const id = `${ruleset.version}:${signature.hash}`;
    let cluster = byHash.get(id);
    if (!cluster) {
      cluster = { id, rulesetVersion: ruleset.version, signature, members: [] };
      byHash.set(id, cluster);
    }
    cluster.members.push(run.fingerprint);
  }
  return [...byHash.values()];
}
