/**
 * 不稳定测试重放库 —— 核心领域类型
 *
 * 设计原则：
 *  - 原始运行记录（RunRecord）一旦导入便不可变；聚类只是建立在原始记录之上的“视图”。
 *  - 所有归一化规则都有版本，失败签名必须标注生成它的规则集版本。
 *  - 重放配方固定种子、环境与调度决策；最小化过程的每一步都留下证据。
 */

/** 进程退出状态：0 视为通过，非 0 视为失败。 */
export type ExitStatus = number;

/** 调度器在某一调度点做出的决策（并发调度轨迹中的一条）。 */
export interface ScheduleDecision {
  /** 在该测试内单调递增的调度步骤编号。 */
  step: number;
  /** 调度点类型，例如 mutex / queue / tick。 */
  point: 'mutex' | 'queue' | 'tick' | string;
  /** 竞争资源或队列的稳定标识。 */
  resource: string;
  /** 被选中的执行体（协程 / worker / 任务）。 */
  selected: string;
  /** 当时所有备选执行体（用于展示“选择了谁、放弃了谁”）。 */
  waiters: string[];
}

/** 虚拟时间里发生的一个事件，例如 sleep 到期、定时器触发。 */
export interface VirtualTimeEvent {
  /** 事件序号。 */
  seq: number;
  /** 事件类型。 */
  kind: 'sleep' | 'timeout' | 'yield' | 'timer' | string;
  /** 事件在虚拟时间轴上的偏移（毫秒）。属于噪声的一部分，不进失败签名。 */
  atMs: number;
  /** 结构化细节，例如请求的睡眠时长。 */
  detail?: Record<string, string | number | boolean>;
}

/**
 * 一条结构化的测试运行记录。这是系统唯一的“事实来源”，永远保留、永不就地修改。
 */
export interface RunRecord {
  /** 测试的稳定名称（通常是 suite :: test）。 */
  testName: string;
  /** 退出状态码。0=通过；其余=失败。 */
  exitStatus: ExitStatus;
  /** 标准输出 / 错误的摘要（原始文本，归一化只发生在签名计算时）。 */
  stdoutSummary: string;
  stderrSummary: string;
  /** 该运行使用的随机种子。 */
  seed: string;
  /** 运行开始时的挂钟时间（ISO-8601）。只用于展示，不参与签名。 */
  startedAt: string;
  /** 运行持续的墙钟毫秒数。噪声，不参与签名。 */
  durationMs: number;
  /**
   * 使用者声明的临时路径根目录（绝对路径前缀）。
   * 归一化时这些前缀会被替换为占位符，但行号、断言值等后缀保持不变。
   */
  tempPathRoots?: string[];
  /**
   * 环境白名单：记录“这次运行相关”的环境变量键值。
   * 导入时原样保留；重放配方可以固定其中的一个子集。
   */
  envWhitelist: Record<string, string>;
  /** 虚拟时间事件序列。 */
  virtualTimeEvents: VirtualTimeEvent[];
  /** 并发调度轨迹。 */
  scheduleDecisions: ScheduleDecision[];
  /** 可选的结构化错误信息，用于更精确的聚类（错误类型 / 消息 / 断言值）。 */
  error?: {
    type: string;
    message: string;
    file?: string;
    line?: number;
    column?: number;
    assertion?: {
      expected: string;
      actual: string;
      operator?: string;
    };
  } | null;
}

/** 一条归一化规则的元数据。规则必须幂等、纯函数、可解释。 */
export interface NormalizerRule {
  /** 规则稳定 ID，例如 duration-noise-v1。 */
  id: string;
  /** 首次引入该规则的规则集版本号。 */
  introducedIn: number;
  /** 人类可读说明：它消除什么噪声、刻意保留什么。 */
  description: string;
}

/** 一次归一化替换的证据：哪条规则、在什么位置、把什么变成了什么。 */
export interface RuleTrace {
  ruleId: string;
  /** 在最终归一化文本中的 0 基字符偏移。 */
  index: number;
  before: string;
  after: string;
}

/** 对某段文本应用某个规则集后的结果。 */
export interface NormalizedText {
  text: string;
  /** 每条规则在该文本上的真实命中次数（不受 traces 样例上限影响）。 */
  ruleHits: Record<string, number>;
  traces: RuleTrace[];
}

/** 一个版本化规则集。 */
export interface Ruleset {
  /** 规则集版本号（1, 2, ...）。 */
  version: number;
  /** 该版本包含的全部规则（含历史规则）。 */
  rules: NormalizerRule[];
  /** 对单个文本片段做归一化。 */
  normalizeText(input: string, ctx: NormalizerContext): NormalizedText;
}

/** 归一化上下文：使用者声明的噪声边界。 */
export interface NormalizerContext {
  /** 该运行声明的临时路径根。 */
  tempPathRoots: string[];
}

/** 失败签名：签名相同 ⇒ 在同一规则集版本下聚为一类。 */
export interface FailureSignature {
  /** 签名算法/规则集版本标识，例如 fail-sig-v1+rules-v2。 */
  scheme: string;
  /** 规则集版本号。 */
  rulesetVersion: number;
  /** 16 字符十六进制哈希。 */
  hash: string;
  /** 参与哈希的规范载荷（JSON 字符串），用于解释与对比。 */
  canonical: string;
  /** 归一化过程中命中的全部规则证据（仅保留少量样例用于解释）。 */
  traces: RuleTrace[];
}

/** 聚类视图：某一规则集版本下的全部聚类。 */
export interface ClusterView {
  rulesetVersion: number;
  clusters: Cluster[];
}

export interface Cluster {
  /** 聚类 ID：rules{version}:{signatureHash}。 */
  id: string;
  testName: string;
  signature: FailureSignature;
  /** 成员为运行指纹，顺序即首次导入顺序（稳定）。 */
  members: string[];
  /** 该聚类所有成员上命中过的规则 -> 命中次数。用于解释聚类依据。 */
  ruleUsage: Record<string, number>;
}

/** 确定性假执行器认识的测试 ID。 */
export type FakeTestId =
  | 'suite/queue-order-flake'
  | 'suite/timeout-flake'
  | 'suite/env-gated-flake';

/** 重放时固定下来的调度决策。 */
export type PinnedDecision = ScheduleDecision;

/**
 * 重放配方：从一条运行建立，固定种子、环境白名单子集与调度决策。
 * 配方只能针对随项目提交的假执行器内的测试，不引用任何外部命令。
 */
export interface ReplayRecipe {
  id: string;
  /** 来源运行的指纹。 */
  sourceRunFingerprint: string;
  /** 来源失败签名使用的规则集版本；重放时用同一版本判定是否复现。 */
  rulesetVersion: number;
  fakeTest: FakeTestId;
  seed: string;
  /** 固定的环境变量（必须来自来源运行的环境白名单，或假执行器声明的兼容键）。 */
  env: Record<string, string>;
  /** 固定的调度决策序列（允许为空，表示交给确定性默认调度）。 */
  schedule: PinnedDecision[];
  /** 期望看到的失败签名哈希；为空表示“期望通过”。 */
  expectedFailureHash: string | null;
  /** 期望的退出状态。 */
  expectedExitStatus: number;
  createdAt: string;
}

/** 环境兼容性检查结论。 */
export type EnvCompatReason =
  | { kind: 'ok' }
  | { kind: 'mode-missing' }
  | { kind: 'mode-unsupported'; requested: string; supported: string[] }
  | { kind: 'bad-number'; variable: string; value: string }
  | { kind: 'extra-variable'; variable: string };

/** 假执行器一次重放的结果。 */
export interface ReplayOutcome {
  fakeTest: FakeTestId;
  exitStatus: number;
  stdoutSummary: string;
  stderrSummary: string;
  virtualTimeEvents: VirtualTimeEvent[];
  scheduleDecisions: ScheduleDecision[];
  envCompat: EnvCompatReason;
  /** 对本次输出用当前规则集计算出的失败签名（通过时为 null）。 */
  observedSignature: FailureSignature | null;
  /**
   * 重放结论：
   *  - reproduced：复现了来源失败
   *  - not-reproduced：运行成功或失败形态变了（绝不计为通过）
   *  - env-incompatible：环境缺失或不被假执行器支持（绝不计为通过）
   */
  verdict: 'reproduced' | 'not-reproduced' | 'env-incompatible';
}

/** 最小化某一步尝试的证据。 */
export interface MinimizationStep {
  index: number;
  /** 这一步尝试删减的内容描述。 */
  action:
    | { kind: 'remove-env'; variable: string }
    | { kind: 'remove-schedule-step'; step: number }
    | { kind: 'baseline' };
  /** 尝试后配方（快照）。 */
  recipe: ReplayRecipe;
  /** 尝试的重放结论。 */
  verdict: ReplayOutcome['verdict'];
  /** 该删减是否被接受（接受=仍然复现）。 */
  accepted: boolean;
  replaysUsed: number;
}

/** 一次最小化实验的完整状态与证据树（按时间顺序的尝试链）。 */
export interface MinimizationState {
  id: string;
  recipeId: string;
  steps: MinimizationStep[];
  /** 最近一次被接受的配方。 */
  currentRecipe: ReplayRecipe;
  currentVerdict: ReplayOutcome['verdict'];
  /** 已用重放次数（含基线）。 */
  replaysUsed: number;
  /** 预算上限（重放次数）。 */
  budget: number;
  /**
   * 状态：
   *  - fixed-point：对当前配方再无可删且仍复现的项（局部最小，不宣称全局最小）
   *  - budget-exhausted：预算耗尽，返回当前最小结果
   *  - in-progress：仍可继续
   */
  status: 'in-progress' | 'fixed-point' | 'budget-exhausted';
  startedAt: string;
  finishedAt: string | null;
  /** 待尝试的删减候选（持久化，使服务器重启后“继续最小化”仍然正确）。 */
  pendingCandidates?: Array<
    | { kind: 'remove-env'; variable: string }
    | { kind: 'remove-schedule-step'; step: number }
  >;
}

/** 服务端持久化的整体状态。 */
export interface StoreState {
  /** 指纹 -> 原始运行。键顺序即导入顺序。 */
  runs: Record<string, RunRecord>;
  /** 与 runs 同序的指纹列表，保证导出/成员顺序稳定。 */
  runOrder: string[];
  recipes: Record<string, ReplayRecipe>;
  minimizations: Record<string, MinimizationState>;
  /** 已生成过的聚类视图，按规则集版本缓存（重算结果稳定）。 */
  clusterViews: Record<number, ClusterView>;
}
