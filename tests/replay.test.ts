import { describe, expect, it } from "vitest";
import {
  EXECUTOR_VERSION,
  checkEnvironment,
  executeRecipe,
} from "../src/core/executor.js";
import { recipeFromRun, replayRecipe, withExpectedSignatures } from "../src/core/recipe.js";
import { importNdjson, emptyStore } from "../src/core/store.js";
import { guardRecipe } from "../src/server/guard.js";
import type { ReplayRecipe } from "../src/core/types.js";

function queueRecipe(overrides: Partial<ReplayRecipe> = {}): ReplayRecipe {
  return {
    id: "recipe-test",
    derivedFromFingerprint: "run-test",
    testName: "suite/queue-drain",
    executorVersion: EXECUTOR_VERSION,
    seed: 11,
    env: {
      WORKDIR: "/tmp/flaky-replay-sandbox/job-1",
      ENABLE_FEATURE_X: "on",
    },
    schedule: [
      { order: 0, actor: "producer", op: "enqueue" },
      { order: 1, actor: "consumer", op: "dequeue" },
      { order: 2, actor: "consumer", op: "dequeue" },
      { order: 3, actor: "producer", op: "enqueue" },
    ],
    virtualTime: [],
    expected: {},
    ...overrides,
  };
}

describe("确定性假执行器", () => {
  it("相同配方总是产生相同输出，且不访问真实环境", () => {
    const recipe = queueRecipe();
    const a = executeRecipe(recipe);
    const b = executeRecipe(recipe);
    expect(b).toEqual(a);
    expect(a.ranAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("奇数种子 + 遗留消息的调度复现 queue-drain 失败", () => {
    const result = executeRecipe(queueRecipe());
    expect(result.exitStatus).toBe("fail");
    expect(result.stdoutSummary).toContain("drain.test.ts:42");
  });

  it("未注册测试 / 未知调度动作被判定为环境不兼容", () => {
    expect(executeRecipe(queueRecipe({ testName: "suite/rm-rf" as never })).outcome).toBe(
      "environment-incompatible",
    );
    expect(
      executeRecipe(
        queueRecipe({
          schedule: [{ order: 0, actor: "shell", op: "exec" } as never],
        }),
      ).outcome,
    ).toBe("environment-incompatible");
  });
});

describe("环境兼容", () => {
  it("白名单外的环境键被拒绝", () => {
    expect(checkEnvironment(queueRecipe({ env: { LD_PRELOAD: "/tmp/x" } })).compatible).toBe(false);
  });

  it("timeout-race 要求 ENABLE_FEATURE_X=on", () => {
    const recipe = queueRecipe({
      testName: "suite/timeout-race",
      env: { WORKDIR: "/tmp/flaky-replay-sandbox/j", ENABLE_FEATURE_X: "off" },
      schedule: [],
    });
    expect(checkEnvironment(recipe).reason).toContain("ENABLE_FEATURE_X");
  });

  it("queue-drain 的 RETRY_COUNT 上限是 3", () => {
    expect(
      checkEnvironment(queueRecipe({ env: { RETRY_COUNT: "5", WORKDIR: "/tmp/flaky-replay-sandbox/j" } }))
        .compatible,
    ).toBe(false);
  });

  it("WORKDIR 必须位于沙箱根下，拒绝相对路径与 .. 片段", () => {
    expect(checkEnvironment(queueRecipe({ env: { WORKDIR: "/etc" } })).compatible).toBe(false);
    expect(
      checkEnvironment(queueRecipe({ env: { WORKDIR: "/tmp/flaky-replay-sandbox/../etc" } })).compatible,
    ).toBe(false);
  });
});

describe("三态重放", () => {
  function recipeFromSampleLine(line: string): ReplayRecipe {
    const store = importNdjson(emptyStore(), line).state;
    const run = store.runs[0]!;
    return withExpectedSignatures(recipeFromRun(run), run);
  }

  it("从失败记录建立的配方复现", () => {
    const recipe = recipeFromSampleLine(sampleQueueFailure());
    expect(replayRecipe(recipe).outcome).toBe("reproduced");
  });

  it("改变种子后未复现，且通过不算复现", () => {
    const recipe = recipeFromSampleLine(sampleQueueFailure());
    const changed = { ...recipe, seed: 12, id: `${recipe.id}-other` };
    expect(replayRecipe(changed).outcome).toBe("not-reproduced");
  });

  it("破坏环境得到 environment-incompatible", () => {
    const recipe = recipeFromSampleLine(sampleTimeoutFailure());
    expect(replayRecipe(recipe).outcome).toBe("reproduced");
    const broken = {
      ...recipe,
      env: { ...recipe.env, ENABLE_FEATURE_X: "off" },
      id: `${recipe.id}-broken`,
    };
    const result = replayRecipe(broken);
    expect(result.outcome).toBe("environment-incompatible");
    expect(result.exitStatus).not.toBe("pass");
  });
});

describe("服务端路径/参数边界", () => {
  it("拒绝越出沙箱的路径", () => {
    const recipe = queueRecipe({ env: { WORKDIR: "/tmp/flaky-replay-sandbox/../../etc/passwd" } });
    expect(guardRecipe(recipe).ok).toBe(false);
    expect(guardRecipe({ ...recipe, env: { WORKDIR: "/Users/victim/.ssh" } }).ok).toBe(false);
  });

  it("拒绝未知测试、错误执行器版本与额外越权字段", () => {
    expect(guardRecipe(queueRecipe({ testName: "suite/x" as never })).ok).toBe(false);
    expect(guardRecipe(queueRecipe({ executorVersion: "custom-shell-1" as never })).ok).toBe(false);
    const withExtra = {
      ...queueRecipe(),
      schedule: [
        ...queueRecipe().schedule,
        { order: 4, actor: "producer", op: "enqueue", command: "rm -rf /" },
      ],
    };
    const guarded = guardRecipe(withExtra);
    expect(guarded.ok).toBe(false);
    expect(guarded.errors.join(" ")).toContain("越权字段");
  });

  it("合规配方通过", () => {
    expect(guardRecipe(queueRecipe()).ok).toBe(true);
  });
});

function sampleQueueFailure(): string {
  const run = {
    testName: "suite/queue-drain",
    status: "fail",
    exitCode: 1,
    stdoutSummary: [
      "FAIL suite/queue-drain",
      "AssertionError: expected queue to be drained before teardown",
      "    at QueueDrain.assertDrained (src/queue/drain.test.ts:42)",
      "values: leftover=1 maxQueue=1 emptyPolls=1",
      "seed=11 pid=41004 interleave=P,C,C,P took 114ms",
      "worker log: /tmp/flaky-replay-sandbox/job-1/worker-11/drain.log",
    ].join("\n"),
    stderrSummary: "",
    seed: 11,
    env: { WORKDIR: "/tmp/flaky-replay-sandbox/job-1", ENABLE_FEATURE_X: "on" },
    tempPathPrefixes: ["/tmp/flaky-replay-sandbox/job-1"],
    durationMs: 114,
    virtualTime: [],
    schedule: queueRecipe().schedule,
  };
  return JSON.stringify(run);
}

function sampleTimeoutFailure(): string {
  return JSON.stringify({
    testName: "suite/timeout-race",
    status: "timeout",
    exitCode: 124,
    stdoutSummary: [
      "FAIL suite/timeout-race",
      "TimeoutError: deadline fired before worker wakeup",
      "    at TimeoutRace.run (src/races/timeout.test.ts:88)",
      "values: limit=100 actual=120 seed=21",
      "pid=41003 elapsed 147ms",
      "timer log: /tmp/flaky-replay-sandbox/job-4/case-21/timers.log",
    ].join("\n"),
    stderrSummary: "test exceeded virtual deadline",
    seed: 21,
    env: {
      WORKDIR: "/tmp/flaky-replay-sandbox/job-4",
      ENABLE_FEATURE_X: "on",
      TZ: "Asia/Tokyo",
    },
    tempPathPrefixes: ["/tmp/flaky-replay-sandbox/job-4"],
    durationMs: 147,
    virtualTime: [
      { atMs: 0, kind: "timer-arm" },
      { atMs: 120, kind: "timer-wake" },
      { atMs: 100, kind: "deadline" },
    ],
    schedule: [],
  });
}
