import { buildSignature, RULE_VERSIONS } from "./normalize.js";
import type { ClusterView, ExitStatus, RuleVersion, StoredRun } from "./types.js";

/**
 * 按规则版本生成聚类视图。新版本规则只会追加新的视图，
 * 已存在版本的视图永远按同样的纯函数重算，因此聚类是稳定的。
 */
export function clusterRuns(
  runs: StoredRun[],
  versions: RuleVersion[] = RULE_VERSIONS,
): ClusterView[] {
  const views: ClusterView[] = [];
  for (const version of versions) {
    const byHash = new Map<
      string,
      {
        signatureHash: string;
        testName: string;
        status: ExitStatus;
        normalizedSummary: string;
        normalization: ClusterView["normalization"];
        members: ClusterView["members"];
      }
    >();

    // 运行以导入顺序进入；成员数组因此天然有序。
    for (const run of runs) {
      if (run.status === "pass") continue;
      const signature = buildSignature(run, version);
      let cluster = byHash.get(signature.signatureHash);
      if (!cluster) {
        cluster = {
          signatureHash: signature.signatureHash,
          testName: signature.testName,
          status: signature.status,
          normalizedSummary: signature.normalizedSummary,
          normalization: signature.normalization,
          members: [],
        };
        byHash.set(signature.signatureHash, cluster);
      }
      cluster.members.push({ fingerprint: run.fingerprint, importSeq: run.importSeq });
    }

    // 聚类顺序也确定性化：先出现成员的聚类排前面，其次按哈希。
    const ordered = [...byHash.values()].sort((a, b) => {
      const firstA = a.members[0]?.importSeq ?? Number.MAX_SAFE_INTEGER;
      const firstB = b.members[0]?.importSeq ?? Number.MAX_SAFE_INTEGER;
      if (firstA !== firstB) return firstA - firstB;
      return a.signatureHash < b.signatureHash ? -1 : 1;
    });

    for (const cluster of ordered) {
      views.push({ ruleVersion: version, ...cluster });
    }
  }
  return views;
}

export function findCluster(
  views: ClusterView[],
  version: RuleVersion,
  signatureHash: string,
): ClusterView | undefined {
  return views.find(
    (view) => view.ruleVersion === version && view.signatureHash === signatureHash,
  );
}
