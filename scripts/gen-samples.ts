/**
 * Generates deterministic sample runs for the shipped demo.
 * Run: pnpm tsx scripts/gen-samples.ts
 *
 * The records are real outputs of the in-process fake executor plus two
 * hand-authored records exercising the v2 pid/uuid rules. No shell involved.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execute, type ExecResponse } from "../src/executor/executor";
import type {
  ScheduleDecision,
  TestRun,
  VirtualTimeEvent,
} from "../src/core/types";
import { runFingerprint } from "../src/core/fingerprint";

interface Input {
  id: string;
  testName: string;
  program: string;
  seed: string;
  envWhitelist: Record<string, string>;
  schedule: ScheduleDecision[];
  tempRoots?: string[];
  importedAt: string;
}

function record(input: Input, exec: ExecResponse): TestRun {
  const base = {
    testName: input.testName,
    program: input.program,
    exitStatus: exec.exitStatus,
    exitCode: exec.exitCode,
    errorType: exec.errorType,
    stdoutSummary: exec.stdoutSummary,
    seed: input.seed,
    envWhitelist: input.envWhitelist,
    virtualTimeEvents: exec.virtualTimeEvents as VirtualTimeEvent[],
    schedule: input.schedule,
    tempRoots: input.tempRoots ?? [],
  };
  return {
    id: input.id,
    importedAt: input.importedAt,
    fingerprint: runFingerprint(base),
    ...base,
  };
}

function manual(
  input: Input,
  patch: Pick<TestRun, "exitStatus" | "exitCode" | "errorType" | "stdoutSummary">,
): TestRun {
  return record(input, {
    compatible: true,
    ...patch,
    virtualTimeEvents: [
      { atMs: 0, kind: "worker", detail: "pid-uuid demo" },
    ],
  });
}

const at = (n: number) => new Date(Date.UTC(2026, 8, 20, 10, n)).toISOString();

const inputs: Array<() => TestRun> = [
  () =>
    record(
      {
        id: "run-timer-01",
        testName: "Timers/flaky deadline fires on time",
        program: "flaky-timer",
        seed: "000e",
        envWhitelist: {
          TIMER_MODE: "virtual",
          RUN_ID: "run-001",
          TMPDIR: "/tmp/build-run-001",
        },
        schedule: [
          { actor: "worker-0", kind: "wake", chosen: 2 },
          { actor: "worker-2", kind: "yield", chosen: 0 },
          { actor: "observer-9", kind: "observe", chosen: 0 },
        ],
        tempRoots: ["/tmp/build-run-001"],
        importedAt: at(0),
      },
      execute({
        program: "flaky-timer",
        seed: "000e",
        env: {
          TIMER_MODE: "virtual",
          RUN_ID: "run-001",
          TMPDIR: "/tmp/build-run-001",
        },
        schedule: [
          { actor: "worker-0", kind: "wake", chosen: 2 },
          { actor: "worker-2", kind: "yield", chosen: 0 },
          { actor: "observer-9", kind: "observe", chosen: 0 },
        ],
        args: [],
        tempRoots: ["/tmp/build-run-001"],
      }),
    ),
  () =>
    record(
      {
        id: "run-timer-02",
        testName: "Timers/flaky deadline fires on time",
        program: "flaky-timer",
        seed: "0003",
        envWhitelist: {
          TIMER_MODE: "virtual",
          RUN_ID: "run-002",
          TMPDIR: "/var/folders/zz/build-run-002",
        },
        schedule: [
          { actor: "worker-1", kind: "wake", chosen: 0 },
          { actor: "observer-2", kind: "observe", chosen: 0 },
        ],
        tempRoots: ["/var/folders/zz/build-run-002"],
        importedAt: at(1),
      },
      execute({
        program: "flaky-timer",
        seed: "0003",
        env: {
          TIMER_MODE: "virtual",
          RUN_ID: "run-002",
          TMPDIR: "/var/folders/zz/build-run-002",
        },
        schedule: [
          { actor: "worker-1", kind: "wake", chosen: 0 },
          { actor: "observer-2", kind: "observe", chosen: 0 },
        ],
        args: [],
        tempRoots: ["/var/folders/zz/build-run-002"],
      }),
    ),
  () =>
    record(
      {
        id: "run-timer-03",
        testName: "Timers/flaky deadline fires on time",
        program: "flaky-timer",
        seed: "7f3a",
        envWhitelist: { TIMER_MODE: "virtual", TMPDIR: "/tmp/ci-run-77" },
        schedule: [],
        tempRoots: ["/tmp/ci-run-77"],
        importedAt: at(2),
      },
      execute({
        program: "flaky-timer",
        seed: "7f3a",
        env: { TIMER_MODE: "virtual", TMPDIR: "/tmp/ci-run-77" },
        schedule: [],
        args: [],
        tempRoots: ["/tmp/ci-run-77"],
      }),
    ),
  () =>
    record(
      {
        id: "run-race-42",
        testName: "Schedules/counter merge is stable",
        program: "data-race",
        seed: "race-a",
        envWhitelist: {},
        schedule: [{ actor: "worker-1", kind: "wake", chosen: 0 }],
        importedAt: at(3),
      },
      execute({
        program: "data-race",
        seed: "race-a",
        env: {},
        schedule: [{ actor: "worker-1", kind: "wake", chosen: 0 }],
        args: [],
        tempRoots: [],
      }),
    ),
  () =>
    record(
      {
        id: "run-race-58",
        testName: "Schedules/counter merge is stable",
        program: "data-race",
        seed: "race-b",
        envWhitelist: {},
        schedule: [
          { actor: "worker-0", kind: "wake", chosen: 0 },
          { actor: "worker-1", kind: "lock-acquire", chosen: 1 },
          { actor: "worker-0", kind: "wake", chosen: 3 },
        ],
        importedAt: at(4),
      },
      execute({
        program: "data-race",
        seed: "race-b",
        env: {},
        schedule: [
          { actor: "worker-0", kind: "wake", chosen: 0 },
          { actor: "worker-1", kind: "lock-acquire", chosen: 1 },
          { actor: "worker-0", kind: "wake", chosen: 3 },
        ],
        args: [],
        tempRoots: [],
      }),
    ),
  () =>
    record(
      {
        id: "run-env-old",
        testName: "Env/requires modern sdk",
        program: "env-sens",
        seed: "env-1",
        envWhitelist: { REQUIRED_SDK: "2.1", TMPDIR: "/tmp/env-probe" },
        schedule: [],
        tempRoots: ["/tmp/env-probe"],
        importedAt: at(5),
      },
      execute({
        program: "env-sens",
        seed: "env-1",
        env: { REQUIRED_SDK: "2.1", TMPDIR: "/tmp/env-probe" },
        schedule: [],
        args: [],
        tempRoots: ["/tmp/env-probe"],
      }),
    ),
  () =>
    manual(
      {
        id: "run-pid-uuid-a",
        testName: "Workers/background flush",
        program: "data-race",
        seed: "pid-a",
        envWhitelist: {},
        schedule: [{ actor: "worker-0", kind: "signal", chosen: 0 }],
        importedAt: at(6),
      },
      {
        exitStatus: "failed",
        exitCode: 1,
        errorType: "AssertionError",
        stdoutSummary:
          "AssertionError: flush order mismatch at flush_test.ts:88\n" +
          "  expected ack, got retry (pid=48213 job 3f2504e0-4f89-11d3-9a0c-0305e82c3301)\n" +
          "  elapsed 1203us",
      },
    ),
  () =>
    manual(
      {
        id: "run-pid-uuid-b",
        testName: "Workers/background flush",
        program: "data-race",
        seed: "pid-b",
        envWhitelist: {},
        schedule: [{ actor: "worker-0", kind: "signal", chosen: 0 }],
        importedAt: at(7),
      },
      {
        exitStatus: "failed",
        exitCode: 1,
        errorType: "AssertionError",
        stdoutSummary:
          "AssertionError: flush order mismatch at flush_test.ts:88\n" +
          "  expected ack, got retry (pid=991 job 6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b)\n" +
          "  elapsed 8800us",
      },
    ),
  () =>
    record(
      {
        id: "run-race-pass",
        testName: "Schedules/counter merge is stable",
        program: "data-race",
        seed: "race-pass",
        envWhitelist: {},
        schedule: [{ actor: "worker-0", kind: "wake", chosen: 0 }],
        importedAt: at(8),
      },
      execute({
        program: "data-race",
        seed: "race-pass",
        env: {},
        schedule: [{ actor: "worker-0", kind: "wake", chosen: 0 }],
        args: [],
        tempRoots: [],
      }),
    ),
];

const runs = inputs.map((build) => build());
const out = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "sample-data",
  "runs.ndjson",
);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, runs.map((run) => JSON.stringify(run)).join("\n") + "\n");
console.log(`wrote ${runs.length} runs to ${out}`);
