export type ExitStatus = "passed" | "failed" | "errored" | "timeout";

export interface VirtualTimeEvent {
  /** Logical (virtual) timestamp in milliseconds since test start. */
  atMs: number;
  kind: string;
  detail: string;
}

export type DecisionKind =
  | "wake"
  | "yield"
  | "lock-acquire"
  | "signal"
  | "observe";

export interface ScheduleDecision {
  /** Stable actor/thread identifier, e.g. "worker-0". */
  actor: string;
  kind: DecisionKind;
  /** Index among the ready actors at the decision point. */
  chosen: number;
}

export interface TestRun {
  /** Stable per-record id, assigned at import if absent. */
  id: string;
  testName: string;
  /** Program the deterministic fake executor knows about, e.g. "flaky-timer". */
  program: string;
  exitStatus: ExitStatus;
  exitCode: number;
  /** Error type for failed/errored runs, e.g. "AssertionError". */
  errorType?: string;
  stdoutSummary: string;
  /** RNG seed in effect during the run. */
  seed: string;
  /** Whitelisted environment variables captured for replay. */
  envWhitelist: Record<string, string>;
  virtualTimeEvents: VirtualTimeEvent[];
  schedule: ScheduleDecision[];
  /**
   * Temporary path roots the importer declares as noise. Values prefixed by
   * one of these roots are collapsed by the normalizer.
   */
  tempRoots?: string[];
  importedAt: string;
  /** Content fingerprint computed at import time; preserved on export/import. */
  fingerprint: string;
}

export type RuleVersion = "v1" | "v2";

export interface NormalizedText {
  text: string;
  /** Rule ids that fired, with a human explanation and hit count. */
  ruleHits: Record<string, number>;
}

export interface FailureSignature {
  testName: string;
  errorType: string;
  signature: string;
  normalizedSummary: string;
  ruleVersion: RuleVersion;
  /** Explanations of every normalization rule that could / did apply. */
  ruleExplanations: RuleExplanation[];
}

export interface RuleExplanation {
  id: string;
  version: RuleVersion;
  description: string;
  hits: number;
}

export interface Cluster {
  id: string;
  ruleVersion: RuleVersion;
  testName: string;
  errorType: string;
  signature: string;
  normalizedSummary: string;
  /** Run ids in stable import order. */
  memberIds: string[];
  ruleExplanations: RuleExplanation[];
}

export type ReplayOutcome = "reproduced" | "not-reproduced" | "env-incompatible";

export interface ReplayRecipe {
  id: string;
  sourceRunId: string;
  program: string;
  seed: string;
  /** Pinned environment whitelist; may be minimized away one entry at a time. */
  env: Record<string, string>;
  /** Pinned scheduling decisions; may be minimized away one event at a time. */
  schedule: ScheduleDecision[];
  args: string[];
  tempRoots: string[];
  createdAt: string;
  note?: string;
}

export interface ReplayResult {
  outcome: ReplayOutcome;
  exitStatus: ExitStatus;
  exitCode: number;
  stdoutSummary: string;
  errorType?: string;
  matchedSignature: boolean;
  /** Why the replay failed to reproduce, when applicable. */
  reason?: string;
}

export type MinimizeItemKind = "env" | "schedule";

export interface MinimizeStep {
  index: number;
  itemKind: MinimizeItemKind;
  itemKey: string;
  outcome: ReplayOutcome;
  accepted: boolean;
  reason: string;
  snapshotRecipeId: string;
}

export interface EvidenceNode {
  id: string;
  label: string;
  removed?: { kind: MinimizeItemKind; key: string };
  outcome: ReplayOutcome;
  accepted: boolean;
  stepIndex?: number;
  children: EvidenceNode[];
}

export type MinimizeSessionStatus = "running" | "budget-exhausted" | "complete";

export interface MinimizeSession {
  id: string;
  recipeId: string;
  targetSignature: string;
  budget: number;
  attemptsUsed: number;
  status: MinimizeSessionStatus;
  steps: MinimizeStep[];
  currentRecipeId: string;
  evidenceTree: EvidenceNode;
  globalMinimumClaimed: boolean;
  /** Stable per-session item ids still queued for a deletion attempt. */
  queue: string[];
  /** Original-schedule index for each event still present in the recipe. */
  scheduleOrigins: number[];
}
