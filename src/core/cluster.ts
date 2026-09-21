import { signatureForRun } from './normalize';
import { fallbackHash } from './fingerprint';
import type {
  Cluster,
  ClusterView,
  NoisePolicy,
  RunRecord,
} from './types';

/**
 * 在给定噪声策略（含规则包版本）下构建聚类视图。
 * - 仅对失败运行聚类；
 * - 聚类与成员顺序完全由 runs 的顺序决定，保证稳定可重放；
 * - 不修改任何原始运行记录。
 */
export function buildClusterView(
  runs: readonly RunRecord[],
  policy: NoisePolicy,
): ClusterView {
  const bySignature = new Map<
    string,
    { memberRunIds: string[]; representativeRunId: string; evidence: Cluster['evidence'] }
  >();

  for (const run of runs) {
    const failure = signatureForRun(run, policy);
    if (failure === null) {
      continue;
    }
    const existing = bySignature.get(failure.signature);
    if (existing) {
      existing.memberRunIds.push(run.id);
    } else {
      bySignature.set(failure.signature, {
        memberRunIds: [run.id],
        representativeRunId: run.id,
        evidence: failure.evidence,
      });
    }
  }

  const clusters: Cluster[] = [];
  for (const [signature, group] of bySignature) {
    clusters.push({
      clusterId: fallbackHash(
        JSON.stringify({
          signature,
          pack: policy.packId,
          version: policy.packVersion,
          policyVersion: policy.policyVersion,
        }),
      ),
      signature,
      memberRunIds: group.memberRunIds,
      representativeRunId: group.representativeRunId,
      packId: policy.packId,
      packVersion: policy.packVersion,
      policyVersion: policy.policyVersion,
      evidence: group.evidence,
    });
  }

  clusters.sort((a, b) => {
    const firstA = a.memberRunIds[0]!;
    const firstB = b.memberRunIds[0]!;
    return runs.findIndex((r) => r.id === firstA) - runs.findIndex((r) => r.id === firstB);
  });

  return {
    viewKey: `view:${policy.packId}@v${policy.packVersion}:p${policy.policyVersion}`,
    packId: policy.packId,
    packVersion: policy.packVersion,
    policyVersion: policy.policyVersion,
    clusters,
  };
}

/** 同时构建多个版本的视图，用于演示“新规则只生成新视图”。 */
export function buildAllViews(
  runs: readonly RunRecord[],
  policies: readonly NoisePolicy[],
): ClusterView[] {
  return policies.map((policy) => buildClusterView(runs, policy));
}
