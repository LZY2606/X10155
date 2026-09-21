/**
 * 首次启动时的确定性演示数据。
 *
 * 其中一部分直接由假执行器产生（因此可以一键重放并最小化），
 * 另一部分是“导入的历史运行”，用于演示临时路径/耗时/挂钟噪声归一化、
 * 行号与断言值差异不被吞掉，以及规则版本升级带来的新聚类视图。
 */
import { executeFakeTest, FAKE_TESTS } from '../core/fakeExecutor.js';
import { runFingerprint } from '../core/fingerprint.js';
import type { RunRecord, ScheduleDecision } from '../core/types.js';

const BOTH_B: ScheduleDecision[] = [
  { step: 0, point: 'queue', resource: 'job-queue', selected: 'consumer-B', waiters: ['consumer-A', 'consumer-B'] },
  { step: 1, point: 'queue', resource: 'job-queue', selected: 'consumer-B', waiters: ['consumer-A', 'consumer-B'] },
];

export interface SeededRuns {
  runs: RunRecord[];
  fingerprints: string[];
  /** 可直接重放的队列失败指纹（用于演示配方与最小化）。 */
  replayableQueueFingerprint: string;
  replayableTimeoutFingerprint: string;
}

export function buildSeedRuns(): SeededRuns {
  const runs: RunRecord[] = [];

  // —— 假执行器直接产生的运行（可重放）——
  const queueFailA = executeFakeTest(
    FAKE_TESTS['suite/queue-order-flake'].id,
    'seed-1',
    { REPLAY_MODE: 'replay' },
    BOTH_B,
  ).run;
  const queueFailB = executeFakeTest(
    FAKE_TESTS['suite/queue-order-flake'].id,
    'seed-47',
    { REPLAY_MODE: 'replay', FLAKY_Q_CAPACITY: '4' },
    BOTH_B,
  ).run;
  // seed-47 默认调度恰好通过：演示“同测试名但不是失败”的运行。
  const queuePass = executeFakeTest(
    FAKE_TESTS['suite/queue-order-flake'].id,
    'seed-47',
    { REPLAY_MODE: 'replay' },
    [],
  ).run;
  const timeoutFailA = executeFakeTest(
    FAKE_TESTS['suite/timeout-flake'].id,
    'seed-1',
    { REPLAY_MODE: 'replay' },
  ).run;
  const gatedFail = executeFakeTest(
    FAKE_TESTS['suite/env-gated-flake'].id,
    'seed-1',
    { REPLAY_MODE: 'replay', FLAKY_FEATURE_TOGGLE: 'on' },
  ).run;

  // —— 导入的历史运行：临时路径、耗时、挂钟时间噪声 ——
  const noisyRuns: RunRecord[] = [
    noisyQueueRun({
      seed: 'ci-7731',
      startedAt: '2026-09-20T11:02:31.482Z',
      durationMs: 842,
      tmp: '/var/folders/9x/zzzzzzzzzzzzzzzzzzzzzz/T/pytest-of-ci/abc123',
      took: '18ms',
    }),
    noisyQueueRun({
      seed: 'ci-7732',
      startedAt: '2026-09-21T08:44:02.005Z',
      durationMs: 1307,
      tmp: '/private/tmp/pytest-of-ci/def456',
      took: '24ms',
    }),
    // 近似但不同：断言实际值变了，必须独立成类。
    noisyQueueRun({
      seed: 'ci-7733',
      startedAt: '2026-09-21T08:45:10.118Z',
      durationMs: 903,
      tmp: '/tmp/pytest-of-ci/ghi789',
      took: '15ms',
      actual: 'alpha,alpha',
    }),
    // 近似但不同：行号变了（修复过程中移动过断言），必须独立成类。
    noisyQueueRun({
      seed: 'ci-7734',
      startedAt: '2026-09-21T09:02:55.900Z',
      durationMs: 970,
      tmp: '/tmp/pytest-of-ci/jkl012',
      took: '21ms',
      line: 43,
    }),
  ];

  runs.push(queueFailA, queueFailB, queuePass, timeoutFailA, gatedFail, ...noisyRuns);
  const fingerprints = runs.map(runFingerprint);

  return {
    runs,
    fingerprints,
    replayableQueueFingerprint: runFingerprint(queueFailA),
    replayableTimeoutFingerprint: runFingerprint(timeoutFailA),
  };
}

interface NoisyOptions {
  seed: string;
  startedAt: string;
  durationMs: number;
  tmp: string;
  took: string;
  actual?: string;
  line?: number;
}

function noisyQueueRun(options: NoisyOptions): RunRecord {
  const actual = options.actual ?? 'beta,beta';
  const line = options.line ?? 42;
  const order = actual.split(',');
  const decisions: ScheduleDecision[] = order.map((job, step) => {
    const selected = job === 'alpha' ? 'consumer-A' : 'consumer-B';
    return {
      step,
      point: 'queue',
      resource: 'job-queue',
      selected,
      waiters: ['consumer-A', 'consumer-B'],
    };
  });
  return {
    testName: 'suite/queue-order-flake',
    exitStatus: 1,
    stdoutSummary: [
      'queue capacity=2',
      `scratch: ${options.tmp}/jobs.json`,
      '[queue] step=0 selected=consumer-B waiters=consumer-A,consumer-B',
      '[queue] step=1 selected=consumer-B waiters=consumer-A,consumer-B',
      `delivery order: ${actual}`,
      `took ${options.took}`,
    ].join('\n'),
    stderrSummary: [
      'AssertionError: queue delivery order mismatch',
      '  expected: alpha,beta',
      `  actual:   ${actual}`,
      `  at tests/queue_test.ts:${line}`,
      `trace artifact: ${options.tmp}/trace.json`,
    ].join('\n'),
    seed: options.seed,
    startedAt: options.startedAt,
    durationMs: options.durationMs,
    tempPathRoots: [options.tmp],
    envWhitelist: { REPLAY_MODE: 'replay' },
    virtualTimeEvents: [
      { seq: 0, kind: 'yield', atMs: 3, detail: { actor: 'consumer-B' } },
      { seq: 1, kind: 'yield', atMs: 9, detail: { actor: 'consumer-B' } },
    ],
    scheduleDecisions: decisions,
    error: {
      type: 'AssertionError',
      message: 'queue delivery order mismatch',
      file: 'tests/queue_test.ts',
      line,
      assertion: { expected: 'alpha,beta', actual, operator: 'deepEqual' },
    },
  };
}
