export interface RunRecord {
  id: string;
  testName: string;
  exitStatus: number;
  stdout: string;
  seed: number;
  env: Record<string, string>;
  virtualTimeEvents: string[];
  schedule: string[];
}

export interface StoredRun extends RunRecord {
  fingerprint: string;
  signature: string;
  importedAt: string;
}

export interface RuleApplication {
  ruleId: string;
  ruleVersion: number;
  description: string;
  replacements: number;
}

export interface NormalizedFailure {
  normalized: string;
  errorType: string | null;
  appliedRules: RuleApplication[];
  signature: string;
  ruleVersion: number;
}

export interface Cluster {
  id: string;
  signature: string;
  ruleVersion: number;
  errorType: string | null;
  exemplar: string;
  appliedRules: RuleApplication[];
  memberRunIds: string[];
}

export interface ClusterView {
  version: number;
  clusters: Cluster[];
}

export interface Recipe {
  id: string;
  name: string;
  baseRunId: string;
  executorPath: string;
  args: string[];
  testName: string;
  seed: number;
  env: Record<string, string>;
  schedule: string[];
  virtualTimeEvents: string[];
  lastOutcome: ReplayOutcome | null;
}

export type ReplayOutcome =
  | "reproduced"
  | "not_reproduced"
  | "environment_incompatible";

export interface ReplayResult {
  outcome: ReplayOutcome;
  reason: string;
  replayedRun?: RunRecord;
  replayedSignature?: string;
}

export interface EvidenceNode {
  id: string;
  parentId: string | null;
  action: string;
  outcome: ReplayOutcome | "start";
  removalKept: boolean;
  children: string[];
}

export interface MinimizeResult {
  recipeId: string;
  recipe: Recipe;
  evidence: EvidenceNode[];
  stepsUsed: number;
  budget: number;
  exhausted: boolean;
  isGlobalMinimum: boolean;
}
