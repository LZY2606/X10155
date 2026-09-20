import type { Cluster, RuleVersion, TestRun } from "./types";
import { failureSignature } from "./normalize";
import { sha256 } from "./canonical";

const FAILING: ReadonlySet<TestRun["exitStatus"]> = new Set([
  "failed",
  "errored",
  "timeout",
]);

export function isFailing(run: TestRun): boolean {
  return FAILING.has(run.exitStatus);
}

/**
 * Cluster failing runs for one rule version. Member order is import order;
 * the returned cluster array itself is sorted deterministically (first member
 * id, then signature) so views stay stable across restarts/exports.
 *
 * Recomputing with the same rule version always yields the same view; adding
 * a new rule version never rewrites the old one.
 */
export function clusterRuns(runs: TestRun[], ruleVersion: RuleVersion): Cluster[] {
  const groups = new Map<
    string,
    {
      signature: ReturnType<typeof failureSignature>;
      memberIds: string[];
    }
  >();

  for (const run of runs) {
    if (!isFailing(run)) continue;
    const sig = failureSignature(run, ruleVersion);
    const existing = groups.get(sig.signature);
    if (existing) {
      existing.memberIds.push(run.id);
    } else {
      groups.set(sig.signature, { signature: sig, memberIds: [run.id] });
    }
  }

  return [...groups.entries()]
    .map(([signature, group]) => ({
      id: clusterId(ruleVersion, signature),
      ruleVersion,
      testName: group.signature.testName,
      errorType: group.signature.errorType,
      signature,
      normalizedSummary: group.signature.normalizedSummary,
      memberIds: group.memberIds,
      ruleExplanations: group.signature.ruleExplanations,
    }))
    .sort(
      (a, b) =>
        a.memberIds[0].localeCompare(b.memberIds[0]) || a.id.localeCompare(b.id),
    );
}

export function clusterId(ruleVersion: RuleVersion, signature: string): string {
  return `${ruleVersion}-${sha256(ruleVersion + ":" + signature).slice(0, 12)}`;
}

/** Token-level diff of two normalized failure summaries. */
export interface DiffToken {
  value: string;
  kind: "same" | "added" | "removed";
}

export function diffSummaries(a: string, b: string): DiffToken[] {
  const ta = tokenize(a);
  const tb = tokenize(b);
  const lcs = buildLcs(ta, tb);
  return renderDiff(ta, tb, lcs);
}

function tokenize(text: string): string[] {
  return text.match(/\s+|\w+|[^\s\w]/g) ?? [];
}

function buildLcs(a: string[], b: string[]): number[][] {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

function renderDiff(a: string[], b: string[], dp: number[][]): DiffToken[] {
  const out: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ value: a[i], kind: "same" });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ value: a[i], kind: "removed" });
      i++;
    } else {
      out.push({ value: b[j], kind: "added" });
      j++;
    }
  }
  while (i < a.length) out.push({ value: a[i++], kind: "removed" });
  while (j < b.length) out.push({ value: b[j++], kind: "added" });
  return out;
}
