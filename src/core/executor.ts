import type {
  ReplayRecipe,
  ReplayResult,
  ScheduleStep,
  VirtualTimeEvent,
} from "./types.js";

/**
 * 随项目提交的确定性假测试执行器。
 * 它不是 shell：不接收任意命令、不触碰进程、不读环境变量、不做文件 IO，
 * 只在一份固定的测试注册表与白名单内做纯函数模拟，因此浏览器演示
 * 不需要（也不可能）借此运行任意用户命令。
 */

export const EXECUTOR_VERSION = "fake-exec-1";

export const REGISTERED_TESTS = ["suite/queue-drain", "suite/timeout-race"] as const;
export type RegisteredTest = (typeof REGISTERED_TESTS)[number];

/** 允许配方固定的环境键与取值形态——执行器自身的环境契约。 */
export const ENV_ALLOWLIST = {
  WORKDIR: {
    kind: "abs-path-under-roots",
    roots: ["/tmp/flaky-replay-sandbox", "/var/tmp/flaky-replay-sandbox"],
  },
  ENABLE_FEATURE_X: { kind: "enum", values: ["on", "off"] },
  RETRY_COUNT: { kind: "int-range", min: 0, max: 5 },
  TZ: { kind: "tz-token" },
} as const;

export const ALLOWED_ACTOR_OPS: Record<string, readonly string[]> = {
  producer: ["enqueue"],
  consumer: ["dequeue"],
};

export const ALLOWED_VIRTUAL_KINDS = ["timer-arm", "timer-wake", "deadline"] as const;

export const MAX_SCHEDULE_STEPS = 64;

export interface ExecutorVerdict {
  compatible: boolean;
  reason?: string;
}

/** 环境契约检查：不兼容是一种被显式建模的结果，绝不能算通过。 */
export function checkEnvironment(recipe: ReplayRecipe): ExecutorVerdict {
  const envKeys = Object.keys(recipe.env).sort();
  for (const key of envKeys) {
    if (!(key in ENV_ALLOWLIST)) {
      return { compatible: false, reason: `环境键 ${key} 不在执行器白名单内` };
    }
  }
  const workdir = recipe.env.WORKDIR;
  if (workdir !== undefined) {
    if (!workdir.startsWith("/")) {
      return { compatible: false, reason: "WORKDIR 必须是绝对路径" };
    }
    const roots = ENV_ALLOWLIST.WORKDIR.roots;
    if (!roots.some((root) => workdir === root || workdir.startsWith(root + "/"))) {
      return {
        compatible: false,
        reason: `WORKDIR ${workdir} 越出执行器沙箱根目录 ${roots.join(" 或 ")}`,
      };
    }
    if (workdir.includes("..")) {
      return { compatible: false, reason: "WORKDIR 不允许包含 .. 片段" };
    }
  }
  const feature = recipe.env.ENABLE_FEATURE_X;
  if (feature !== undefined && !["on", "off"].includes(feature)) {
    return { compatible: false, reason: "ENABLE_FEATURE_X 只接受 on/off" };
  }
  const retries = recipe.env.RETRY_COUNT;
  if (retries !== undefined && !/^\d+$/.test(retries)) {
    return { compatible: false, reason: "RETRY_COUNT 必须是非负整数" };
  }
  if (retries !== undefined && (Number(retries) < 0 || Number(retries) > 5)) {
    return { compatible: false, reason: "RETRY_COUNT 超出 0..5" };
  }
  const tz = recipe.env.TZ;
  if (tz !== undefined && !/^(?:UTC|[A-Za-z_]+\/[A-Za-z_]+)$/.test(tz)) {
    return { compatible: false, reason: `TZ ${tz} 不是受支持的时区令牌` };
  }

  if (recipe.testName === "suite/timeout-race" && feature === "off") {
    return {
      compatible: false,
      reason: "suite/timeout-race 在 fake-exec-1 中要求 ENABLE_FEATURE_X=on",
    };
  }
  if (recipe.testName === "suite/queue-drain" && retries !== undefined && Number(retries) > 3) {
    return {
      compatible: false,
      reason: "suite/queue-drain 的 worker 池最多支持 RETRY_COUNT=3",
    };
  }
  return { compatible: true };
}

/** 调度轨迹的结构检查（执行者/动作注册表 + 序号连续）。 */
export function checkSchedule(schedule: ScheduleStep[]): ExecutorVerdict {
  if (schedule.length > MAX_SCHEDULE_STEPS) {
    return { compatible: false, reason: `调度事件超过 ${MAX_SCHEDULE_STEPS} 步上限` };
  }
  let expectedOrder = 0;
  for (const step of schedule) {
    if (step.order !== expectedOrder) {
      return { compatible: false, reason: `调度序号不连续：期望 ${expectedOrder}，实际 ${step.order}` };
    }
    expectedOrder += 1;
    const ops = ALLOWED_ACTOR_OPS[step.actor];
    if (!ops || !ops.includes(step.op)) {
      return { compatible: false, reason: `未注册的调度决策 ${step.actor}:${step.op}` };
    }
  }
  return { compatible: true };
}

export function checkVirtualTime(events: VirtualTimeEvent[]): ExecutorVerdict {
  for (const event of events) {
    if (typeof event.atMs !== "number" || event.atMs < 0) {
      return { compatible: false, reason: "虚拟时间 atMs 必须是非负数" };
    }
    if (!ALLOWED_VIRTUAL_KINDS.includes(event.kind as (typeof ALLOWED_VIRTUAL_KINDS)[number])) {
      return { compatible: false, reason: `未注册的虚拟时间事件 ${event.kind}` };
    }
  }
  return { compatible: true };
}

function pseudoPid(seed: number): number {
  return 41000 + ((seed % 7) + 7) % 7;
}

interface SimOutput {
  status: "pass" | "fail" | "timeout";
  exitCode: number;
  stdoutSummary: string;
  stderrSummary: string;
  durationMs: number;
}

function simulateQueueDrain(recipe: ReplayRecipe): SimOutput {
  const seed = recipe.seed;
  const workdir = recipe.env.WORKDIR ?? "/tmp/flaky-replay-sandbox";
  const pid = pseudoPid(seed);
  let queue = 0;
  let maxQueue = 0;
  let enqueues = 0;
  let dequeues = 0;
  let emptyPolls = 0;
  for (const step of recipe.schedule) {
    if (step.actor === "producer" && step.op === "enqueue") {
      queue += 1;
      enqueues += 1;
      maxQueue = Math.max(maxQueue, queue);
    } else {
      if (queue > 0) {
        queue -= 1;
        dequeues += 1;
      } else {
        emptyPolls += 1;
      }
    }
  }
  const leftover = enqueues - dequeues;
  // 奇数种子下，末尾发布的消息错过消费窗口——这是被固定下来的“不稳定”决策。
  const flaky = leftover > 0 && ((seed % 2) + 2) % 2 === 1;
  const interleave = recipe.schedule
    .map((step) => (step.actor === "producer" ? "P" : "C"))
    .join(",");
  const durationMs = 100 + ((seed * 13) % 47) + (flaky ? 12 : 0);
  const logPath = `${workdir}/worker-${seed}/drain.log`;
  if (flaky) {
    return {
      status: "fail",
      exitCode: 1,
      durationMs,
      stdoutSummary: [
        "FAIL suite/queue-drain",
        "AssertionError: expected queue to be drained before teardown",
        "    at QueueDrain.assertDrained (src/queue/drain.test.ts:42)",
        `values: leftover=${leftover} maxQueue=${maxQueue} emptyPolls=${emptyPolls}`,
        `seed=${seed} pid=${pid} interleave=${interleave} took ${durationMs}ms`,
        `worker log: ${logPath}`,
      ].join("\n"),
      stderrSummary: "",
    };
  }
  return {
    status: "pass",
    exitCode: 0,
    durationMs,
    stdoutSummary: [
      "PASS suite/queue-drain",
      `queue drained: enqueues=${enqueues} dequeues=${dequeues} emptyPolls=${emptyPolls}`,
      `seed=${seed} pid=${pid} interleave=${interleave || "<empty>"} took ${durationMs}ms`,
    ].join("\n"),
    stderrSummary: "",
  };
}

function simulateTimeoutRace(recipe: ReplayRecipe): SimOutput {
  const seed = recipe.seed;
  const workdir = recipe.env.WORKDIR ?? "/tmp/flaky-replay-sandbox";
  const pid = pseudoPid(seed);
  const arm = recipe.virtualTime.find((event) => event.kind === "timer-arm");
  const wake = recipe.virtualTime.find((event) => event.kind === "timer-wake");
  const deadline = recipe.virtualTime.find((event) => event.kind === "deadline");
  const armAt = arm?.atMs ?? 0;
  const wakeAt = wake?.atMs ?? 0;
  const deadlineAt = deadline?.atMs ?? 0;
  const limit = Math.max(0, deadlineAt - armAt);
  const actual = Math.max(0, wakeAt - armAt);
  const raced = wakeAt >= deadlineAt;
  const durationMs = 90 + ((seed * 17) % 53) + (raced ? 40 : 0);
  const logPath = `${workdir}/case-${seed}/timers.log`;
  if (raced) {
    return {
      status: "timeout",
      exitCode: 124,
      durationMs,
      stdoutSummary: [
        "FAIL suite/timeout-race",
        "TimeoutError: deadline fired before worker wakeup",
        "    at TimeoutRace.run (src/races/timeout.test.ts:88)",
        // 断言值是裸数字，不带时间单位词，因此归一化绝不会吞掉它们。
        `values: limit=${limit} actual=${actual} seed=${seed}`,
        `pid=${pid} elapsed ${durationMs}ms`,
        `timer log: ${logPath}`,
      ].join("\n"),
      stderrSummary: "test exceeded virtual deadline",
    };
  }
  return {
    status: "pass",
    exitCode: 0,
    durationMs,
    stdoutSummary: [
      "PASS suite/timeout-race",
      `worker woke before deadline: limit=${limit} actual=${actual}`,
      `seed=${seed} pid=${pid} took ${durationMs}ms`,
    ].join("\n"),
    stderrSummary: "",
  };
}

/** 执行一条配方：纯函数、确定性、可任意重放。 */
export function executeRecipe(recipe: ReplayRecipe): ReplayResult {
  const base = {
    recipeId: recipe.id,
    executorVersion: EXECUTOR_VERSION,
    virtualTime: recipe.virtualTime.map((event) => ({ ...event })),
    schedule: recipe.schedule.map((step) => ({ ...step })),
    ranAt: "1970-01-01T00:00:00.000Z",
  };

  const incompatible = (reason: string): ReplayResult => ({
    ...base,
    outcome: "environment-incompatible",
    exitStatus: "crash",
    exitCode: 87,
    stdoutSummary: `SKIP ${recipe.testName}: environment incompatible`,
    stderrSummary: reason,
    durationMs: 0,
    incompatibilityReason: reason,
  });

  if (!(REGISTERED_TESTS as readonly string[]).includes(recipe.testName)) {
    return incompatible(`测试 ${recipe.testName} 未在 ${EXECUTOR_VERSION} 注册表中`);
  }
  const envCheck = checkEnvironment(recipe);
  if (!envCheck.compatible) return incompatible(envCheck.reason ?? "环境不兼容");
  const scheduleCheck = checkSchedule(recipe.schedule);
  if (!scheduleCheck.compatible) return incompatible(scheduleCheck.reason ?? "调度不兼容");
  const virtualCheck = checkVirtualTime(recipe.virtualTime);
  if (!virtualCheck.compatible) return incompatible(virtualCheck.reason ?? "虚拟时间不兼容");

  const output =
    recipe.testName === "suite/queue-drain"
      ? simulateQueueDrain(recipe)
      : simulateTimeoutRace(recipe);

  return {
    ...base,
    outcome: "not-reproduced",
    exitStatus: output.status,
    exitCode: output.exitCode,
    stdoutSummary: output.stdoutSummary,
    stderrSummary: output.stderrSummary,
    durationMs: output.durationMs,
  };
}
