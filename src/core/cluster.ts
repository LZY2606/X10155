import type { Cluster, ClusterView, RunRecord } from "./types.js";
import { normalizeFailureOutput, type NormalizationContext } from "./normalize.js";

export function buildClusterView(
  runs: RunRecord[],
  ctx: NormalizationContext,
  version: number,
): ClusterView {
  const bySignature = new Map<string, Cluster>();
  const clusters: Cluster[] = [];
  for (const run of runs) {
    if (run.exitStatus === 0) continue;
    const norm = normalizeFailureOutput(run.stdout, ctx, version);
    let cluster = bySignature.get(norm.signature);
    if (!cluster) {
      cluster = {
        id: `c-${norm.signature.slice(0, 12)}`,
        signature: norm.signature,
        ruleVersion: version,
        errorType: norm.errorType,
        exemplar: norm.normalized,
        appliedRules: norm.appliedRules,
        memberRunIds: [],
      };
      bySignature.set(norm.signature, cluster);
      clusters.push(cluster);
    }
    if (!cluster.memberRunIds.includes(run.id)) {
      cluster.memberRunIds.push(run.id);
    }
  }
  return { version, clusters };
}
