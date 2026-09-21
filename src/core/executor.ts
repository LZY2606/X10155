import { EXECUTOR_CAPABILITIES, type EnvironmentRequirements } from './compatibility';
import type { ScheduleEvent, VirtualTimeEvent } from './types';

/**
 * 确定性假测试执行器：随项目提交，纯函数、无 shell、无文件系统、无网络。
 * 浏览器只能通过服务端调用这里注册的测试，且参数经过白名单校验，
 * 因此不存在任意命令执行或路径逃逸。
 */

export interface ExecutorInput {
  seed: number;
  env: Readonly<Record<string, string>>;
  schedule: readonly ScheduleEvent[];
}

export interface ExecutorOutput {
  exitStatus: number;
  stdoutSummary: string;
  virtualTime: readonly VirtualTimeEvent[];
  durationMs: number;
  requirements: EnvironmentRequirements;
}

interface FakeTest {
  testId: string;
  requirements: EnvironmentRequirements;
  run: (input: ExecutorInput) => Omit<ExecutorOutput, 'requirements'>;
}

/** 确定性 32 位伪随机：同种子永远给出同序列。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function baseVirtualTime(
  input: ExecutorInput,
  durationMs: number,
): VirtualTimeEvent[] {
  const events: VirtualTimeEvent[] = [
    { atMs: 0, kind: 'start', detail: 'fake-executor:boot' },
  ];
  for (const event of input.schedule) {
    events.push({
      atMs: event.atMs,
      kind: 'schedule',
      detail: `${event.actor}:${event.action}:${event.resource}`,
    });
  }
  events.push({ atMs: durationMs, kind: 'end', detail: 'fake-executor:shutdown' });
  return events.sort((a, b) => a.atMs - b.atMs);
}

/**
 * race-order：当脚本化调度中 worker-1 在 worker-0 释放前进入同一把锁时失败。
 * 完全由配方里的 schedule 与 WORKER_COUNT 决定，种子只影响耗时抖动。
 */
function runRaceOrder(
  input: ExecutorInput,
  variant: 'line42' | 'line51' | 'token2' | 'timeout-type',
): Omit<ExecutorOutput, 'requirements'> {
  const jitter = 30 + (input.seed % 13);
  const workers = Number(input.env.WORKER_COUNT ?? '1');
  const enters = input.schedule
    .filter((event) => event.action === 'enter')
    .sort((a, b) => a.seq - b.seq);
  const overlap = (() => {
    for (const first of enters) {
      if (first.actor !== 'worker-0') {
        continue;
      }
      const leave = input.schedule.find(
        (event) =>
          event.action === 'leave' &&
          event.actor === 'worker-0' &&
          event.resource === first.resource,
      );
      const intruder = enters.find(
        (event) =>
          event.actor === 'worker-1' &&
          event.resource === first.resource &&
          event.seq > first.seq &&
          (!leave || event.seq < leave.seq),
      );
      if (intruder && workers >= 2) {
        return true;
      }
    }
    return false;
  })();

  if (!overlap) {
    return {
      exitStatus: 0,
      stdoutSummary: `ok - critical section serialized across ${workers} worker (${jitter} ms)`,
      virtualTime: baseVirtualTime(input, jitter),
      durationMs: jitter,
    };
  }

  const line = variant === 'line51' ? 51 : 42;
  const assertion =
    variant === 'token2'
      ? 'expected 1 held token but received 2'
      : 'expected schedule to be conflict-free but worker-1 entered lock:account while worker-0 held 1 token';
  const errorType = variant === 'timeout-type' ? 'TimeoutError' : 'AssertionError';
  const summary = [
    `${errorType}: critical section overlapped`,
    `  ${assertion}`,
    `    at runner/race.ts:${line}`,
    '  trace root: /private/tmp/race-replay/work/account.lock (0x7f9a2c10b400)',
    `  elapsed: ${jitter} ms`,
  ].join('\n');
  return {
    exitStatus: 1,
    stdoutSummary: summary,
    virtualTime: baseVirtualTime(input, jitter),
    durationMs: jitter,
  };
}

const BASE_INSTANT = Date.UTC(2026, 8, 22, 3, 0, 0, 0);

/** timeout-flake：总是抖动超时；ISO 时间戳与线程号由种子确定性推出。 */
function runTimeoutFlake(
  input: ExecutorInput,
): Omit<ExecutorOutput, 'requirements'> {
  const random = mulberry32(input.seed ^ 0x9e3779b9);
  const thread = 3 + Math.floor(random() * 10);
  const offsetMs = Math.floor(random() * 90000);
  const when = new Date(BASE_INSTANT + offsetMs).toISOString();
  const elapsed = 1500 + (input.seed % 7);
  const summary = [
    'TimeoutError: worker stall exceeded budget',
    `  timer did not fire within 1500 ms (thread ${thread}, at ${when})`,
    '    at runner/timeout.ts:88',
    `  wait elapsed: ${elapsed} ms`,
  ].join('\n');
  return {
    exitStatus: 1,
    stdoutSummary: summary,
    virtualTime: baseVirtualTime(input, elapsed),
    durationMs: elapsed,
  };
}

function runNetworkFlake(
  input: ExecutorInput,
): Omit<ExecutorOutput, 'requirements'> {
  const jitter = 44 + (input.seed % 11);
  const summary = [
    'Error: ECONNRESET while contacting fixture service',
    '    at runner/network.ts:17',
    `  retry window: ${jitter} ms`,
  ].join('\n');
  return {
    exitStatus: 1,
    stdoutSummary: summary,
    virtualTime: baseVirtualTime(input, jitter),
    durationMs: jitter,
  };
}

function runAlwaysPass(
  input: ExecutorInput,
): Omit<ExecutorOutput, 'requirements'> {
  const jitter = 8 + (input.seed % 5);
  return {
    exitStatus: 0,
    stdoutSummary: `ok - 12 assertions passed (${jitter} ms)`,
    virtualTime: baseVirtualTime(input, jitter),
    durationMs: jitter,
  };
}

const LINUX_BASE: EnvironmentRequirements = {
  platform: 'linux',
  runtimeVersion: '22.11.0',
  caps: ['clock:virtual', 'scheduler:scripted', 'fs:sandbox'],
};

const REGISTRY: Readonly<Record<string, FakeTest>> = {
  'race-order': {
    testId: 'race-order',
    requirements: LINUX_BASE,
    run: (input) => runRaceOrder(input, 'line42'),
  },
  'race-order:line51': {
    testId: 'race-order:line51',
    requirements: LINUX_BASE,
    run: (input) => runRaceOrder(input, 'line51'),
  },
  'race-order:token2': {
    testId: 'race-order:token2',
    requirements: LINUX_BASE,
    run: (input) => runRaceOrder(input, 'token2'),
  },
  'race-order:timeout-type': {
    testId: 'race-order:timeout-type',
    requirements: LINUX_BASE,
    run: (input) => runRaceOrder(input, 'timeout-type'),
  },
  'timeout-flake': {
    testId: 'timeout-flake',
    requirements: LINUX_BASE,
    run: runTimeoutFlake,
  },
  'network-flake': {
    testId: 'network-flake',
    requirements: { ...LINUX_BASE, caps: [...LINUX_BASE.caps, 'net:egress'] },
    run: runNetworkFlake,
  },
  'always-pass': {
    testId: 'always-pass',
    requirements: LINUX_BASE,
    run: runAlwaysPass,
  },
  'race-order:win32': {
    testId: 'race-order:win32',
    requirements: { ...LINUX_BASE, platform: 'win32' },
    run: (input) => runRaceOrder(input, 'line42'),
  },
};

export function registeredTestIds(): readonly string[] {
  return Object.keys(REGISTRY);
}

export function isRegisteredTest(testId: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, testId);
}

export function requirementsOf(testId: string): EnvironmentRequirements {
  const test = REGISTRY[testId];
  if (!test) {
    throw new Error(`未注册的假测试：${testId}`);
  }
  return test.requirements;
}

/** 执行已注册假测试。调用方负责先做参数校验与兼容性检查。 */
export function fakeExecute(testId: string, input: ExecutorInput): ExecutorOutput {
  const test = REGISTRY[testId];
  if (!test) {
    throw new Error(`未注册的假测试：${testId}`);
  }
  return { ...test.run(input), requirements: test.requirements };
}

export { EXECUTOR_CAPABILITIES };
