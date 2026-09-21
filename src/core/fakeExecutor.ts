/**
 * 确定性假测试执行器（随项目提交）。
 *
 * 安全边界：
 *  - 它不启动任何进程、不解释 shell、不执行用户提供的命令；
 *    所谓“重放”只是纯函数：(假测试 id, 种子, 环境, 调度决策) -> 结构化运行结果。
 *  - 服务端在调用前必须通过 validateRecipeRequest：拒绝未知测试、越界环境键/值、
 *    越出执行器的调度点/执行体，以及任何试图夹带路径或参数的内容。
 */
import { canonicalJson } from './canonical.js';
import { fnv1a64Hex } from './hash.js';
import { signatureForRun } from './signature.js';
import type {
  EnvCompatReason,
  FailureSignature,
  FakeTestId,
  PinnedDecision,
  ReplayOutcome,
  ReplayRecipe,
  RunRecord,
  ScheduleDecision,
  VirtualTimeEvent,
} from './types.js';

/** 尝试越出假执行器时抛出的错误；服务端把它翻译成 422。 */
export class ExecutorBoundaryError extends Error {}

export interface FakeTestDefinition {
  id: FakeTestId;
  title: string;
  /** 该测试认可的全部环境变量键。 */
  allowedEnvKeys: string[];
  /** 必需的环境变量键；缺失即环境不兼容。 */
  requiredEnvKeys: string[];
  /** 声明为“路径类”的键：值必须落在沙箱临时根之下。 */
  pathEnvKeys: string[];
  /** 该测试拥有的调度点 -> 允许出现的执行体集合。 */
  schedulePoints: Record<string, string[]>;
}

export const FAKE_TESTS: Record<FakeTestId, FakeTestDefinition> = {
  'suite/queue-order-flake': {
    id: 'suite/queue-order-flake',
    title: '并发队列：消费者在高竞争下偶发抢占导致顺序反转',
    allowedEnvKeys: ['REPLAY_MODE', 'FLAKY_Q_CAPACITY'],
    requiredEnvKeys: ['REPLAY_MODE'],
    pathEnvKeys: [],
    schedulePoints: {
      queue: ['consumer-A', 'consumer-B'],
    },
  },
  'suite/timeout-flake': {
    id: 'suite/timeout-flake',
    title: '虚拟时间超时：抖动超过固定阈值',
    allowedEnvKeys: ['REPLAY_MODE', 'FLAKY_TIMEOUT_MS'],
    requiredEnvKeys: ['REPLAY_MODE'],
    pathEnvKeys: [],
    schedulePoints: {},
  },
  'suite/env-gated-flake': {
    id: 'suite/env-gated-flake',
    title: '环境开关：只有特定开关组合才进入失败分支',
    allowedEnvKeys: ['REPLAY_MODE', 'FLAKY_FEATURE_TOGGLE', 'FLAKY_TMPDIR'],
    requiredEnvKeys: ['REPLAY_MODE'],
    pathEnvKeys: ['FLAKY_TMPDIR'],
    schedulePoints: {},
  },
};

export const SUPPORTED_REPLAY_MODES = ['replay', 'record'];

/** 沙箱临时根：任何路径类环境值必须解析到它之内。 */
export function sandboxTempRoot(): string {
  // 固定为项目内目录，绝不使用 /tmp 或用户提供的路径。
  return `${process.cwd()}/data/sandbox`;
}

/** mulberry32：确定性 32 位 PRNG。 */
function mulberry32(seed: string): () => number {
  let state = Number(BigInt(`0x${fnv1a64Hex(seed)}`) & 0xffffffffn) >>> 0;
  if (state === 0) {
    state = 0x9e3779b9;
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sessionId(seed: string): string {
  return fnv1a64Hex(`session:${seed}`).slice(0, 12);
}

function sessionTmp(seed: string): string {
  return `/tmp/pytest-of-tester/${sessionId(seed)}`;
}

/**
 * 服务端边界校验。任何一项不过都拒绝（不进入重放，也不算一次重放尝试）：
 *  - 测试必须是执行器内置测试；
 *  - 环境键必须在该测试的白名单内，值不得包含 NUL、换行、shell 元字符或 '..'；
 *  - 路径类环境值必须解析在沙箱临时根之内（杜绝路径逃逸）；
 *  - 调度决策引用的调度点/执行体必须是该测试真实存在的。
 */
export function validateRecipeRequest(
  fakeTest: string,
  env: Record<string, string>,
  schedule: PinnedDecision[],
): FakeTestDefinition {
  const definition = FAKE_TESTS[fakeTest as FakeTestId];
  if (!definition) {
    throw new ExecutorBoundaryError(`未知的假测试: ${fakeTest}（执行器不运行任何外部命令）`);
  }

  for (const [key, value] of Object.entries(env)) {
    if (!definition.allowedEnvKeys.includes(key)) {
      throw new ExecutorBoundaryError(
        `环境变量 ${key} 不在测试 ${fakeTest} 的白名单内（允许：${definition.allowedEnvKeys.join(', ')}）`,
      );
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
      throw new ExecutorBoundaryError(`环境变量 ${key} 的值必须是 1..256 字符的字符串`);
    }
    if (/[\0\n\r]|\.\./.test(value) || /[;&|`$<>(){}\\]/.test(value)) {
      throw new ExecutorBoundaryError(`环境变量 ${key} 的值包含被禁止的路径或 shell 元字符`);
    }
    if (definition.pathEnvKeys.includes(key)) {
      assertInsideSandbox(value);
    }
  }

  const seenSteps = new Set<number>();
  for (const decision of schedule) {
    const allowedActors = definition.schedulePoints[decision.point];
    if (!allowedActors) {
      throw new ExecutorBoundaryError(
        `测试 ${fakeTest} 不存在调度点 ${decision.point}（已知：${Object.keys(definition.schedulePoints).join(', ') || '无'}）`,
      );
    }
    if (!allowedActors.includes(decision.selected)) {
      throw new ExecutorBoundaryError(
        `调度点 ${decision.point} 不允许执行体 ${decision.selected}（允许：${allowedActors.join(', ')}）`,
      );
    }
    for (const waiter of decision.waiters) {
      if (!allowedActors.includes(waiter)) {
        throw new ExecutorBoundaryError(`调度点 ${decision.point} 的备选执行体 ${waiter} 不被执行器认识`);
      }
    }
    if (seenSteps.has(decision.step)) {
      throw new ExecutorBoundaryError(`调度步骤 ${decision.step} 重复`);
    }
    seenSteps.add(decision.step);
  }

  return definition;
}

function assertInsideSandbox(value: string): void {
  if (!value.startsWith(sandboxTempRoot() + '/') && value !== sandboxTempRoot()) {
    throw new ExecutorBoundaryError(
      `路径 ${value} 越出了假执行器沙箱 ${sandboxTempRoot()}（拒绝路径逃逸）`,
    );
  }
}

interface SimulatedRun {
  compat: EnvCompatReason;
  exitStatus: number;
  stdoutSummary: string;
  stderrSummary: string;
  virtualTimeEvents: VirtualTimeEvent[];
  scheduleDecisions: ScheduleDecision[];
  error: RunRecord['error'];
  tempRoots: string[];
}

function pinnedAt(schedule: PinnedDecision[], step: number): PinnedDecision | undefined {
  return schedule.find((decision) => decision.step === step);
}

function simulateQueue(seed: string, env: Record<string, string>, schedule: PinnedDecision[]): SimulatedRun {
  const capacityRaw = env.FLAKY_Q_CAPACITY ?? '2';
  const capacity = Number.parseInt(capacityRaw, 10);
  if (!Number.isFinite(capacity)) {
    return incompat({ kind: 'bad-number', variable: 'FLAKY_Q_CAPACITY', value: capacityRaw });
  }

  const rand = mulberry32(seed);
  const tmp = sessionTmp(seed);
  const decisions: ScheduleDecision[] = [];
  const selections: string[] = [];
  for (let step = 0; step < 2; step += 1) {
    const waiters = ['consumer-A', 'consumer-B'];
    const pinned = pinnedAt(schedule, step);
    const fallback = rand() < 0.5 ? 'consumer-A' : 'consumer-B';
    const selected = pinned?.selected ?? fallback;
    decisions.push({ step, point: 'queue', resource: 'job-queue', selected, waiters });
    selections.push(selected);
  }

  const jobOf = (consumer: string) => (consumer === 'consumer-A' ? 'alpha' : 'beta');
  const observed = selections.map(jobOf);
  const failed = observed.join(',') !== 'alpha,beta';

  const stdout = [
    `queue capacity=${capacity}`,
    `scratch: ${tmp}/jobs.json`,
    ...decisions.map((d) => `[queue] step=${d.step} selected=${d.selected} waiters=${d.waiters.join(',')}`),
    `delivery order: ${observed.join(',')}`,
    `took ${8 + Math.floor(rand() * 20)}ms`,
  ].join('\n');

  const virtualTimeEvents: VirtualTimeEvent[] = [
    { seq: 0, kind: 'yield', atMs: 1 + Math.floor(rand() * 5), detail: { actor: selections[0] } },
    { seq: 1, kind: 'yield', atMs: 6 + Math.floor(rand() * 5), detail: { actor: selections[1] } },
  ];

  if (!failed) {
    return {
      compat: { kind: 'ok' },
      exitStatus: 0,
      stdoutSummary: stdout,
      stderrSummary: '',
      virtualTimeEvents,
      scheduleDecisions: decisions,
      error: null,
      tempRoots: [tmp],
    };
  }

  const stderr = [
    'AssertionError: queue delivery order mismatch',
    '  expected: alpha,beta',
    `  actual:   ${observed.join(',')}`,
    '  at tests/queue_test.ts:42',
    `trace artifact: ${tmp}/trace.json`,
  ].join('\n');

  return {
    compat: { kind: 'ok' },
    exitStatus: 1,
    stdoutSummary: stdout,
    stderrSummary: stderr,
    virtualTimeEvents,
    scheduleDecisions: decisions,
    tempRoots: [tmp],
    error: {
      type: 'AssertionError',
      message: 'queue delivery order mismatch',
      file: 'tests/queue_test.ts',
      line: 42,
      assertion: { expected: 'alpha,beta', actual: observed.join(','), operator: 'deepEqual' },
    },
  };
}

function incompat(reason: EnvCompatReason): SimulatedRun {
  return {
    compat: reason,
    exitStatus: -1,
    stdoutSummary: '',
    stderrSummary: '',
    virtualTimeEvents: [],
    scheduleDecisions: [],
    error: null,
    tempRoots: [],
  };
}

function simulateTimeout(seed: string, env: Record<string, string>): SimulatedRun {
  const thresholdRaw = env.FLAKY_TIMEOUT_MS ?? '50';
  const threshold = Number.parseInt(thresholdRaw, 10);
  if (!Number.isFinite(threshold) || threshold < 0) {
    return incompat({ kind: 'bad-number', variable: 'FLAKY_TIMEOUT_MS', value: thresholdRaw });
  }

  const rand = mulberry32(seed);
  const base = 40 + Math.floor(rand() * 20); // 40..59
  const jitter = Math.floor(rand() * 30); // 0..29
  const observedMs = base + jitter; // 可能越过阈值
  const exceeded = observedMs > threshold;
  const tmp = sessionTmp(seed);

  const virtualTimeEvents: VirtualTimeEvent[] = [
    { seq: 0, kind: 'sleep', atMs: 10 + Math.floor(rand() * 8), detail: { requestedMs: 10 } },
    {
      seq: 1,
      kind: 'timeout',
      atMs: observedMs,
      detail: { observedMs, thresholdMs: threshold },
    },
  ];

  const stdout = [
    `timeout suite threshold=${threshold}ms`,
    `workdir: ${tmp}/work`,
    `elapsed ${5 + Math.floor(rand() * 10)}ms until settle`,
  ].join('\n');

  if (!exceeded) {
    return {
      compat: { kind: 'ok' },
      exitStatus: 0,
      stdoutSummary: `${stdout}\ncompleted within threshold (${observedMs}ms)`,
      stderrSummary: '',
      virtualTimeEvents,
      scheduleDecisions: [],
      error: null,
      tempRoots: [tmp],
    };
  }

  const stderr = [
    'TimeoutError: virtual deadline exceeded',
    `  expected: observedMs <= ${threshold}`,
    `  actual:   observedMs == ${observedMs}`,
    '  at tests/timeout_test.ts:88',
  ].join('\n');

  return {
    compat: { kind: 'ok' },
    exitStatus: 2,
    stdoutSummary: stdout,
    stderrSummary: stderr,
    virtualTimeEvents,
    scheduleDecisions: [],
    tempRoots: [tmp],
    error: {
      type: 'TimeoutError',
      message: 'virtual deadline exceeded',
      file: 'tests/timeout_test.ts',
      line: 88,
      assertion: {
        expected: `observedMs <= ${threshold}`,
        actual: `observedMs == ${observedMs}`,
        operator: '<=',
      },
    },
  };
}

function simulateEnvGated(seed: string, env: Record<string, string>): SimulatedRun {
  const tmp = env.FLAKY_TMPDIR ?? `${sandboxTempRoot()}/default`;
  const rand = mulberry32(seed);
  const virtualTimeEvents: VirtualTimeEvent[] = [
    { seq: 0, kind: 'timer', atMs: 12 + Math.floor(rand() * 30), detail: { gate: 'toggle' } },
  ];

  if (env.FLAKY_FEATURE_TOGGLE !== 'on') {
    // 开关未打开：代码分支根本不会被执行，测试通过。
    return {
      compat: { kind: 'ok' },
      exitStatus: 0,
      stdoutSummary: `feature gate off; skipped\nartifact dir: ${tmp}`,
      stderrSummary: '',
      virtualTimeEvents,
      scheduleDecisions: [],
      error: null,
      tempRoots: [tmp],
    };
  }

  const observed = 7000 + Math.floor(rand() * 900);
  const stdout = [
    'feature gate on; entering gated branch',
    `artifact dir: ${tmp}`,
    `waited ${10 + Math.floor(rand() * 30)}ms for gate`,
  ].join('\n');
  const stderr = [
    'Error: gated branch produced unexpected quota',
    `  expected: 6500`,
    `  actual:   ${observed}`,
    '  at tests/gated_test.ts:23',
  ].join('\n');

  return {
    compat: { kind: 'ok' },
    exitStatus: 1,
    stdoutSummary: stdout,
    stderrSummary: stderr,
    virtualTimeEvents,
    scheduleDecisions: [],
    tempRoots: [tmp],
    error: {
      type: 'Error',
      message: 'gated branch produced unexpected quota',
      file: 'tests/gated_test.ts',
      line: 23,
      assertion: { expected: '6500', actual: String(observed), operator: 'strictEqual' },
    },
  };
}

function simulate(
  fakeTest: FakeTestId,
  seed: string,
  env: Record<string, string>,
  schedule: PinnedDecision[],
): SimulatedRun {
  switch (fakeTest) {
    case 'suite/queue-order-flake':
      return simulateQueue(seed, env, schedule);
    case 'suite/timeout-flake':
      return simulateTimeout(seed, env);
    case 'suite/env-gated-flake':
      return simulateEnvGated(seed, env);
  }
}

export interface FakeExecution {
  run: RunRecord;
  compat: EnvCompatReason;
}

/** 直接执行内置假测试（用于从配方生成来源运行 / 生成演示数据）。 */
export function executeFakeTest(
  fakeTest: FakeTestId,
  seed: string,
  env: Record<string, string>,
  schedule: PinnedDecision[] = [],
): FakeExecution {
  validateRecipeRequest(fakeTest, env, schedule);
  const sim = simulate(fakeTest, seed, env, schedule);
  return { run: toRunRecord(fakeTest, seed, env, sim), compat: sim.compat };
}

function toRunRecord(
  fakeTest: FakeTestId,
  seed: string,
  env: Record<string, string>,
  sim: SimulatedRun,
): RunRecord {
  return {
    testName: fakeTest,
    exitStatus: sim.exitStatus,
    stdoutSummary: sim.stdoutSummary,
    stderrSummary: sim.stderrSummary,
    seed,
    // 挂钟时间不进入失败签名；这里使用固定值，保证假执行器本身完全确定。
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 0,
    tempPathRoots: sim.tempRoots,
    envWhitelist: { ...env },
    virtualTimeEvents: sim.virtualTimeEvents,
    scheduleDecisions: sim.scheduleDecisions,
    error: sim.error,
  };
}

/**
 * 重放一个配方。边界问题（未知测试、路径逃逸、越权环境键、非法执行体）抛
 * ExecutorBoundaryError，由服务端翻译成 422；环境缺失/不支持/坏数字属于
 * env-incompatible（不是通过，也不是“未复现”）。
 */
export function replayRecipe(
  recipe: ReplayRecipe,
  rulesetVersion: number,
): ReplayOutcome {
  validateRecipeRequest(recipe.fakeTest, recipe.env, recipe.schedule);

  const base: Pick<
    ReplayOutcome,
    'fakeTest' | 'exitStatus' | 'stdoutSummary' | 'stderrSummary' |
    'virtualTimeEvents' | 'scheduleDecisions'
  > = {
    fakeTest: recipe.fakeTest,
    exitStatus: -1,
    stdoutSummary: '',
    stderrSummary: '',
    virtualTimeEvents: [],
    scheduleDecisions: [],
  };

  const mode = recipe.env.REPLAY_MODE;
  let compat: EnvCompatReason = { kind: 'ok' };
  if (mode === undefined) {
    compat = { kind: 'mode-missing' };
  } else if (!SUPPORTED_REPLAY_MODES.includes(mode)) {
    compat = { kind: 'mode-unsupported', requested: mode, supported: [...SUPPORTED_REPLAY_MODES] };
  }
  if (compat.kind !== 'ok') {
    return { ...base, envCompat: compat, observedSignature: null, verdict: 'env-incompatible' };
  }

  const sim = simulate(recipe.fakeTest, recipe.seed, recipe.env, recipe.schedule);
  if (sim.compat.kind !== 'ok') {
    return {
      ...base,
      envCompat: sim.compat,
      observedSignature: null,
      verdict: 'env-incompatible',
    };
  }

  const run = toRunRecord(recipe.fakeTest, recipe.seed, recipe.env, sim);
  const observedSignature: FailureSignature | null =
    run.exitStatus === 0 ? null : signatureForRun(run, rulesetVersion);

  const failureMatches =
    recipe.expectedFailureHash === null
      ? run.exitStatus === 0
      : observedSignature?.hash === recipe.expectedFailureHash &&
        run.exitStatus === recipe.expectedExitStatus;

  return {
    fakeTest: recipe.fakeTest,
    exitStatus: run.exitStatus,
    stdoutSummary: run.stdoutSummary,
    stderrSummary: run.stderrSummary,
    virtualTimeEvents: run.virtualTimeEvents,
    scheduleDecisions: run.scheduleDecisions,
    envCompat: { kind: 'ok' },
    observedSignature,
    verdict: failureMatches ? 'reproduced' : 'not-reproduced',
  };
}

export function recipeId(recipe: Omit<ReplayRecipe, 'id'>): string {
  return `recipe_${fnv1a64Hex(
    canonicalJson({
      fakeTest: recipe.fakeTest,
      seed: recipe.seed,
      env: recipe.env,
      schedule: recipe.schedule,
      expectedFailureHash: recipe.expectedFailureHash,
      expectedExitStatus: recipe.expectedExitStatus,
    }),
  )}`;
}
