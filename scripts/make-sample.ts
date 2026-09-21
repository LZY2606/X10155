/**
 * 生成随项目提交的示例 NDJSON。所有失败记录都通过与服务端相同的
 * 确定性假执行器产出，因此导入后建立的配方一定能在演示页面复现。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeExecute, type ExecutorInput } from '../src/core/executor';
import type { RunRecord, ScheduleEvent } from '../src/core/types';

function sched(...events: Array<[number, number, string, string, string]>): ScheduleEvent[] {
  return events.map(([seq, atMs, actor, action, resource]) => ({
    seq,
    atMs,
    actor,
    action,
    resource,
  }));
}

const RACE_FAIL_SCHEDULE = sched(
  [0, 0, 'worker-0', 'enter', 'lock:account'],
  [1, 12, 'worker-1', 'enter', 'lock:account'],
  [2, 25, 'worker-0', 'leave', 'lock:account'],
);
const RACE_PASS_SCHEDULE = sched(
  [0, 0, 'worker-0', 'enter', 'lock:account'],
  [1, 25, 'worker-0', 'leave', 'lock:account'],
  [2, 30, 'worker-1', 'enter', 'lock:account'],
  [3, 45, 'worker-1', 'leave', 'lock:account'],
);
const TIMEOUT_SCHEDULE = sched(
  [0, 0, 'timer', 'post', 'timer:stall'],
  [1, 1500, 'main', 'wake', 'timer:stall'],
);
const NETWORK_SCHEDULE = sched([0, 0, 'main', 'post', 'socket:retry']);

const raceEnv = (seed: number): Record<string, string> => ({
  WORKER_COUNT: '2',
  LOG_LEVEL: seed % 2 === 0 ? 'debug' : 'info',
  TMPDIR_ROOT: `/private/tmp/race-replay-${seed}`,
});

interface Sample {
  id: string;
  testId: string;
  scenario: string;
  seed: number;
  env: Record<string, string>;
  schedule: ScheduleEvent[];
  recordedAt: string;
}

const samples: Sample[] = [
  {
    id: 'r01',
    testId: 'race-order',
    scenario: 'checkout > flaky lock overlap',
    seed: 11,
    env: raceEnv(11),
    schedule: RACE_FAIL_SCHEDULE,
    recordedAt: '2026-09-22T03:05:11.000Z',
  },
  {
    id: 'r02',
    testId: 'race-order',
    scenario: 'checkout > flaky lock overlap',
    seed: 47,
    env: raceEnv(47),
    schedule: RACE_FAIL_SCHEDULE,
    recordedAt: '2026-09-22T03:07:02.000Z',
  },
  {
    id: 'r03',
    testId: 'race-order',
    scenario: 'checkout > flaky lock overlap',
    seed: 83,
    env: raceEnv(83),
    schedule: RACE_FAIL_SCHEDULE,
    recordedAt: '2026-09-22T03:09:44.000Z',
  },
  {
    id: 'r04',
    testId: 'race-order:line51',
    scenario: 'checkout > flaky lock overlap',
    seed: 11,
    env: raceEnv(11),
    schedule: RACE_FAIL_SCHEDULE,
    recordedAt: '2026-09-22T03:11:09.000Z',
  },
  {
    id: 'r05',
    testId: 'race-order:token2',
    scenario: 'checkout > flaky lock overlap',
    seed: 11,
    env: raceEnv(11),
    schedule: RACE_FAIL_SCHEDULE,
    recordedAt: '2026-09-22T03:12:51.000Z',
  },
  {
    id: 'r06',
    testId: 'race-order:timeout-type',
    scenario: 'checkout > flaky lock overlap',
    seed: 11,
    env: raceEnv(11),
    schedule: RACE_FAIL_SCHEDULE,
    recordedAt: '2026-09-22T03:14:33.000Z',
  },
  {
    id: 'r07',
    testId: 'race-order',
    scenario: 'checkout > flaky lock overlap',
    seed: 11,
    env: raceEnv(11),
    schedule: RACE_PASS_SCHEDULE,
    recordedAt: '2026-09-22T03:16:20.000Z',
  },
  {
    id: 'r08',
    testId: 'timeout-flake',
    scenario: 'scheduler > timer backpressure',
    seed: 5,
    env: { LOG_LEVEL: 'warn', TMPDIR_ROOT: '/private/tmp/to-5' },
    schedule: TIMEOUT_SCHEDULE,
    recordedAt: '2026-09-22T03:18:02.000Z',
  },
  {
    id: 'r09',
    testId: 'timeout-flake',
    scenario: 'scheduler > timer backpressure',
    seed: 5,
    env: { LOG_LEVEL: 'warn', TMPDIR_ROOT: '/private/tmp/to-9' },
    schedule: TIMEOUT_SCHEDULE,
    recordedAt: '2026-09-22T03:20:17.000Z',
  },
  {
    id: 'r10',
    testId: 'network-flake',
    scenario: 'fixtures > service reachability',
    seed: 9,
    env: { NETWORK_MODE: 'fixture', TMPDIR_ROOT: '/private/tmp/net-10' },
    schedule: NETWORK_SCHEDULE,
    recordedAt: '2026-09-22T03:22:40.000Z',
  },
  {
    id: 'r11',
    testId: 'race-order:win32',
    scenario: 'checkout > windows lane overlap',
    seed: 11,
    env: raceEnv(11),
    schedule: RACE_FAIL_SCHEDULE,
    recordedAt: '2026-09-22T03:24:58.000Z',
  },
  {
    id: 'r12',
    testId: 'always-pass',
    scenario: 'smoke > deterministic baseline',
    seed: 3,
    env: { LOG_LEVEL: 'error' },
    schedule: sched([0, 0, 'main', 'post', 'suite:done']),
    recordedAt: '2026-09-22T03:26:31.000Z',
  },
];

function toRun(sample: Sample): RunRecord {
  const input: ExecutorInput = {
    seed: sample.seed,
    env: sample.env,
    schedule: sample.schedule,
  };
  const output = fakeExecute(sample.testId, input);
  return {
    id: sample.id,
    testName: `${sample.testId} > ${sample.scenario}`,
    exitStatus: output.exitStatus,
    stdoutSummary: output.stdoutSummary,
    seed: sample.seed,
    env: sample.env,
    virtualTime: output.virtualTime,
    schedule: sample.schedule,
    durationMs: output.durationMs,
    requirements: output.requirements,
    recordedAt: sample.recordedAt,
  };
}

const runs = samples.map(toRun);
const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '../public/data/sample-runs.ndjson');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, runs.map((run) => JSON.stringify(run)).join('\n') + '\n');
console.log(`已写入 ${runs.length} 条示例运行到 ${outPath}`);
