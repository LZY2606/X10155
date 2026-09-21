/** 结构化测试运行记录与库领域类型。 */

export type ExitStatus = "pass" | "fail" | "timeout" | "crash";

/** 虚拟时间（逻辑时钟）事件，毫秒单位为逻辑时间，与墙钟无关。 */
export interface VirtualTimeEvent {
  atMs: number;
  kind: string;
  detail?: string;
}

/** 一次并发调度决策。 */
export interface ScheduleStep {
  order: number;
  actor: string;
  op: string;
  detail?: string;
}

/** 导入的一条结构化测试运行记录（NDJSON 一行）。 */
export interface RunRecord {
  /** 客户端可缺省；缺省时由规范字段重新计算。 */
  fingerprint?: string;
  testName: string;
  status: ExitStatus;
  exitCode: number;
  stdoutSummary: string;
  stderrSummary?: string;
  seed?: number;
  /** 使用者声明的环境白名单：只保留这些键对应的值。 */
  env?: Record<string, string>;
  /** 使用者声明的临时路径前缀（参与归一化，而不是静默删除）。 */
  tempPathPrefixes?: string[];
  durationMs?: number;
  virtualTime?: VirtualTimeEvent[];
  schedule?: ScheduleStep[];
  recordedAt?: string;
}

/** 持久化的运行：指纹与导入序号都确定。 */
export interface StoredRun extends RunRecord {
  fingerprint: string;
  importSeq: number;
}

export type RuleVersion = string;

/** 归一化规则对单个文本片段的一次替换（可解释证据）。 */
export interface NormalizationTransform {
  ruleId: string;
  description: string;
  /** 命中的原文（可能多次出现，给出全部命中）。 */
  matches: string[];
  replacement: string;
}

/** 归一化产物：规范文本 + 每一条规则如何作用的完整解释。 */
export interface NormalizedText {
  text: string;
  ruleVersion: RuleVersion;
  transforms: NormalizationTransform[];
}

/** 失败签名：刻意不吞行号 / 错误类型 / 断言值。 */
export interface FailureSignature {
  ruleVersion: RuleVersion;
  testName: string;
  status: ExitStatus;
  /** 归一化后的失败摘要。 */
  normalizedSummary: string;
  /** 参与签名的每一步归一化解释。 */
  normalization: NormalizedText;
  /** 签名哈希（确定性，跨进程稳定）。 */
  signatureHash: string;
}

export interface ClusterMember {
  fingerprint: string;
  importSeq: number;
}

export interface ClusterView {
  ruleVersion: RuleVersion;
  signatureHash: string;
  testName: string;
  status: ExitStatus;
  normalizedSummary: string;
  /** 解释这个聚类用了哪些归一化规则（取成员的解释，成员同源则一致）。 */
  normalization: NormalizedText;
  /** 成员按导入顺序排列，导出保持该顺序。 */
  members: ClusterMember[];
}

/** 重放配方：从一条失败运行派生，固定种子 / 环境 / 调度。 */
export interface ReplayRecipe {
  id: string;
  derivedFromFingerprint: string;
  testName: string;
  executorVersion: string;
  seed: number;
  env: Record<string, string>;
  schedule: ScheduleStep[];
  virtualTime: VirtualTimeEvent[];
  /** 期望复现的失败签名哈希（按规则版本）。 */
  expected: Partial<Record<RuleVersion, string>>;
  note?: string;
}

export type ReplayOutcome = "reproduced" | "not-reproduced" | "environment-incompatible";

export interface ReplayResult {
  outcome: ReplayOutcome;
  recipeId: string;
  executorVersion: string;
  exitStatus: ExitStatus;
  exitCode: number;
  stdoutSummary: string;
  stderrSummary: string;
  durationMs: number;
  /** reproduced 时，命中的签名哈希；其余情况为空。 */
  matchedSignature?: string;
  /** environment-incompatible 时给出原因。 */
  incompatibilityReason?: string;
  /** 确定性执行器自身的轨迹证据。 */
  virtualTime: VirtualTimeEvent[];
  schedule: ScheduleStep[];
  ranAt: string;
}

/** 最小化证据树的一个节点。 */
export interface MinimizerNode {
  id: string;
  parentId: string | null;
  recipe: ReplayRecipe;
  replay: ReplayResult | null;
  accepted: boolean;
  rejected: boolean;
  /** 相对父节点删除了什么：环境键或第几个调度事件。 */
  removal:
    | { kind: "env"; key: string; value: string }
    | { kind: "schedule"; index: number; step: ScheduleStep }
    | null;
  reason: string;
  budgetRemaining: number;
}

export type MinimizerStatus =
  | "initial"
  | "in-progress"
  | "single-removal-minimal"
  | "budget-exhausted-current-minimum";

export interface MinimizerState {
  id: string;
  runFingerprint: string;
  ruleVersion: RuleVersion;
  nodes: MinimizerNode[];
  currentMinimalRecipeId: string;
  attempts: number;
  budget: number;
  budgetRemaining: number;
  status: MinimizerStatus;
  updatedAt: string;
}
