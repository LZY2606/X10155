/** 一条结构化的测试运行记录（导入的基本单元）。 */
export interface RunRecord {
  /** 客户端提供的运行 id（可选，缺省时由指纹代替）。 */
  id?: string;
  testName: string;
  exitStatus: number;
  /** 标准输出摘要（完整文本或截断文本，视为摘要）。 */
  stdout: string;
  seed: number;
  /** 环境白名单：仅这些键值被捕获并参与重放。 */
  env: Record<string, string>;
  /** 运行平台，用于环境兼容性判定。 */
  platform: string;
  /** 用户声明的临时路径（归一化时忽略其噪声）。 */
  declaredTempPaths: string[];
  /** 虚拟时间事件序列。 */
  virtualTime: string[];
  /** 并发调度轨迹。 */
  schedule: string[];
}

/** 带服务端元数据的运行记录。 */
export interface StoredRun extends RunRecord {
  /** 内容指纹（sha256，规范化 JSON）。 */
  fingerprint: string;
  /** 导入顺序，决定聚类成员顺序。 */
  seq: number;
  importedAt: string;
}

export interface RuleApplication {
  ruleId: string;
  version: number;
  /** 该规则命中的替换次数。 */
  replacements: number;
}

/** 失败签名：对“为什么失败”的可解释摘要。 */
export interface FailureSignature {
  /** 签名哈希（聚类键）。 */
  hash: string;
  testName: string;
  exitStatus: number;
  /** 归一化后的标准输出摘要。 */
  normalizedStdout: string;
  /** 生成该签名所用规则集版本。 */
  rulesetVersion: string;
  /** 逐条规则的应用记录（可解释性）。 */
  appliedRules: RuleApplication[];
}

export interface Cluster {
  /** 聚类 id = 规则集版本 + 签名哈希。 */
  id: string;
  rulesetVersion: string;
  signature: FailureSignature;
  /** 成员运行指纹，顺序 = 导入顺序（稳定）。 */
  members: string[];
}

export interface NormalizationRule {
  id: string;
  version: number;
  description: string;
  apply(input: string, run: RunRecord): { output: string; replacements: number };
}

export interface Ruleset {
  version: string;
  rules: NormalizationRule[];
}

export type ReplayOutcomeKind =
  | 'reproduced'
  | 'not_reproduced'
  | 'environment_incompatible';

export interface ReplayOutcome {
  kind: ReplayOutcomeKind;
  /** 只有 reproduced 才算“复现”；其余两种都不得算通过。 */
  reproduced: boolean;
  reason?: string;
  actual?: { exitStatus: number; stdout: string };
}

/** 重放配方：从一条运行固定种子、环境与调度决策。 */
export interface ReplayRecipe {
  id: string;
  runId: string;
  createdAt: string;
  /** 必须指向随项目提交的确定性假测试执行器。 */
  command: string;
  args: string[];
  seed: number;
  env: Record<string, string>;
  platform: string;
  /** 从原始运行继承的声明临时路径，用于重放输出的归一化。 */
  declaredTempPaths: string[];
  virtualTime: string[];
  schedule: string[];
}

export interface MinimizeAction {
  type: 'remove-env' | 'remove-schedule-event' | 'remove-virtual-time-event';
  key: string;
}

export interface EvidenceNode {
  id: string;
  parentId: string | null;
  step: number;
  action: MinimizeAction | null;
  outcome: ReplayOutcomeKind | 'root';
  /** 该步之后配方是否保留了此删减。 */
  kept: boolean;
  /** 该步配方的摘要（env/schedule 规模），供证据树浏览。 */
  recipeSummary: { envKeys: string[]; schedule: string[]; virtualTime: string[] };
}

export type MinimizeStatus = 'idle' | 'running' | 'complete' | 'budget_exhausted';

export interface MinimizeState {
  recipeId: string;
  budget: number;
  usedSteps: number;
  status: MinimizeStatus;
  /** 预算耗尽时为 false —— 绝不伪称全局最小。 */
  isGlobalMinimum: boolean;
  /** 待尝试的删减候选队列。 */
  pending: MinimizeAction[];
  /** 当前最小配方。 */
  current: ReplayRecipe;
  evidence: EvidenceNode[];
}
