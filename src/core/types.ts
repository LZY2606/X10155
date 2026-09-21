/**
 * 不稳定测试重放库的核心领域类型。
 * 所有结构化数据均可 JSON 序列化，导入/导出与持久化直接复用这些形状。
 */

/** 虚拟时间轴上的事件，时间戳为单调虚拟时间（毫秒）。 */
export interface VirtualTimeEvent {
  readonly atMs: number;
  readonly kind: string;
  readonly detail: string;
}

/** 并发调度轨迹中的一次决策。 */
export interface ScheduleEvent {
  readonly seq: number;
  readonly atMs: number;
  /** 被调度执行的参与者，例如 worker-0 / timer / main。 */
  readonly actor: string;
  /** 调度动作，例如 enter / leave / post / wake。 */
  readonly action: string;
  readonly resource: string;
}

/** 单次结构化测试运行记录（原始记录永不修改）。 */
export interface RunRecord {
  /** 导入方提供或导入时分配的稳定标识。 */
  readonly id: string;
  readonly testName: string;
  /** 进程退出状态：0 表示通过，非 0 表示失败。 */
  readonly exitStatus: number;
  /** 标准输出摘要（截断后的短文本）。 */
  readonly stdoutSummary: string;
  readonly seed: number;
  /** 本次运行观察到的环境白名单：仅包含白名单内变量。 */
  readonly env: Readonly<Record<string, string>>;
  readonly virtualTime: readonly VirtualTimeEvent[];
  readonly schedule: readonly ScheduleEvent[];
  /** 运行耗时（毫秒），属于持续时间噪声。 */
  readonly durationMs: number;
  /** 该测试声明需要的执行环境能力，用于环境兼容性判断。 */
  readonly requirements: Readonly<{
    platform: string;
    runtimeVersion: string;
    caps: readonly string[];
  }>;
  /** ISO 8601 导入/采集时间，仅用于展示与排序，不参与失败签名。 */
  readonly recordedAt: string;
}

/** 归一化规则：对失败文本做一次可解释的替换。 */
export interface NormalizeRule {
  readonly id: string;
  readonly description: string;
  /** 匹配该规则的正则；source/flags 都会随规则版本持久化。 */
  readonly patternSource: string;
  readonly patternFlags: string;
  readonly replacement: string;
}

/** 不可变规则包：新版本只生成新的聚类视图，旧视图保持不变。 */
export interface RulePack {
  readonly packId: string;
  readonly packVersion: number;
  readonly description: string;
  readonly rules: readonly NormalizeRule[];
}

/** 用户声明的噪声策略：临时路径根 + 规则包版本。 */
export interface NoisePolicy {
  /** 归一化时视为临时目录的路径前缀，如 /tmp 或用户自声明路径。 */
  readonly tempRoots: readonly string[];
  readonly packId: string;
  /** 策略自身版本；变更临时路径声明会形成新版本。 */
  readonly policyVersion: number;
}

/** 一次规则命中的证据，解释签名是如何被归一化得到的。 */
export interface RuleHit {
  readonly ruleId: string;
  readonly matched: string;
  readonly index: number;
  readonly replacement: string;
}

/** 失败签名计算的完整证据。 */
export interface SignatureEvidence {
  readonly rawFailureText: string;
  readonly normalizedText: string;
  /** 命中的临时路径噪声（不依赖规则包）。 */
  readonly tempHits: ReadonlyArray<{ root: string; matched: string; index: number }>;
  readonly ruleHits: readonly RuleHit[];
  readonly packId: string;
  readonly packVersion: number;
  readonly policyVersion: number;
}

export interface FailureSignature {
  readonly signature: string;
  readonly evidence: SignatureEvidence;
}

/** 一个聚类：同一规则版本下签名相同的失败运行。 */
export interface Cluster {
  readonly clusterId: string;
  readonly signature: string;
  /** 成员按首次出现顺序（导入顺序）排列，并始终保持。 */
  readonly memberRunIds: readonly string[];
  readonly representativeRunId: string;
  readonly packId: string;
  readonly packVersion: number;
  readonly policyVersion: number;
  readonly evidence: SignatureEvidence;
}

export interface ClusterView {
  readonly viewKey: string;
  readonly packId: string;
  readonly packVersion: number;
  readonly policyVersion: number;
  readonly clusters: readonly Cluster[];
}

/** 重放配方：固定种子、环境与调度决策。 */
export interface ReplayRecipe {
  readonly recipeVersion: 1;
  readonly id: string;
  readonly sourceRunId: string;
  readonly testId: string;
  readonly seed: number;
  readonly env: Readonly<Record<string, string>>;
  readonly schedule: readonly ScheduleEvent[];
  /** 配方目标签名：重放后期望复现的失败。 */
  readonly targetSignature: string;
  readonly targetPackId: string;
  readonly targetPackVersion: number;
  readonly createdAt: string;
}

export type ReplayOutcome =
  | 'reproduced'
  | 'not-reproduced'
  | 'environment-incompatible';

export interface ReplayResult {
  readonly outcome: ReplayOutcome;
  readonly exitStatus: number;
  readonly stdoutSummary: string;
  readonly observedSignature: string | null;
  readonly targetSignature: string;
  /** 环境不兼容时逐条列出原因。 */
  readonly incompatibilities: readonly string[];
  readonly virtualTime: readonly VirtualTimeEvent[];
  readonly durationMs: number;
  readonly ranAt: string;
}

export interface EvidenceNode {
  readonly nodeId: string;
  readonly step: number;
  readonly kind: 'baseline' | 'remove-env' | 'remove-schedule' | 'accepted' | 'rejected';
  readonly description: string;
  readonly removedKeys: readonly string[];
  readonly replay: ReplayResult;
  readonly children: readonly EvidenceNode[];
}

export type MinimizeStatus =
  | 'reproducing'
  | 'minimized'
  | 'budget-exhausted'
  | 'could-not-reproduce'
  | 'environment-incompatible';

export interface MinimizeSession {
  readonly sessionId: string;
  readonly recipeId: string;
  readonly status: MinimizeStatus;
  /** 每次重放的调用预算。 */
  readonly budget: number;
  readonly replaysUsed: number;
  /** 当前最小（或预算耗尽时的当前最佳）配方。 */
  currentRecipe: ReplayRecipe;
  /** 单调步骤编号，逐步最小化时使用。 */
  step: number;
  /** 完整证据树。 */
  evidence: EvidenceNode;
}

/** 导出/导入包：运行指纹与聚类成员顺序必须保持。 */
export interface ExportBundle {
  readonly format: 'flaky-replay-vault';
  readonly formatVersion: 1;
  readonly exportedAt: string;
  readonly runs: readonly RunRecord[];
  readonly noisePolicy: NoisePolicy;
  readonly recipes: readonly ReplayRecipe[];
  /** 各视图下的聚类清单（含成员顺序），导入后用于校验顺序稳定。 */
  readonly clusterViews: readonly ClusterView[];
}

export interface ImportReport {
  readonly imported: number;
  readonly skippedDuplicates: number;
  readonly errors: readonly { line: number; error: string }[];
  /** 指纹冲突：同 id 但内容不同的记录将被拒绝。 */
  readonly fingerprintConflicts: readonly string[];
}
