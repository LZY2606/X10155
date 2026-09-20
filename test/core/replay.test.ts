import { describe, expect, it } from "vitest";
import { execute } from "../../src/executor/executor";
import { recipeFromRun } from "../../src/core/recipe";
import { replayRecipe } from "../../src/core/replay";
import type { ReplayRecipe, TestRun } from "../../src/core/types";
import { runFingerprint } from "../../src/core/fingerprint";

function runFromExec(
  partial: Pick<TestRun, "testName" | "program" | "seed" | "envWhitelist" | "schedule">,
  exec: ReturnType<typeof execute>,
  tempRoots: string[] = [],
): TestRun {
  const base = {
    ...partial,
    exitStatus: exec.exitStatus,
    exitCode: exec.exitCode,
    errorType: exec.errorType,
    stdoutSummary: exec.stdoutSummary,
    virtualTimeEvents: exec.virtualTimeEvents,
    tempRoots,
  };
  const fingerprint = runFingerprint(base);
  return {
    id: "source",
    importedAt: new Date(0).toISOString(),
    fingerprint,
    ...base,
  };
}

describe("replay outcomes", () => {
  it("reproduces a pinned flaky-timer timeout", () => {
    const request = {
      program: "flaky-timer" as const,
      seed: "000e",
      env: {
        TIMER_MODE: "virtual",
        RUN_ID: "run-001",
        TMPDIR: "/tmp/build-run-001",
      },
      schedule: [
        { actor: "worker-0", kind: "wake" as const, chosen: 2 },
        { actor: "worker-2", kind: "yield" as const, chosen: 0 },
      ],
      args: [] as string[],
      tempRoots: ["/tmp/build-run-001"],
    };
    const exec = execute(request);
    expect(exec.compatible).toBe(true);
    expect(exec.exitStatus).toBe("timeout");
    const source = runFromExec(
      {
        testName: "Timers/flaky deadline fires on time",
        program: "flaky-timer",
        seed: request.seed,
        envWhitelist: request.env,
        schedule: request.schedule,
      },
      exec,
      request.tempRoots,
    );
    const recipe = recipeFromRun(source);
    expect(replayRecipe(recipe, source).outcome).toBe("reproduced");
  });

  it("classifies a changed seed that passes as not-reproduced", () => {
    const failingExec = execute({
      program: "data-race",
      seed: "race-a",
      env: {},
      schedule: [{ actor: "worker-1", kind: "wake", chosen: 0 }],
      args: [],
      tempRoots: [],
    });
    const source = runFromExec(
      {
        testName: "Schedules/counter merge is stable",
        program: "data-race",
        seed: "race-a",
        envWhitelist: {},
        schedule: [{ actor: "worker-1", kind: "wake", chosen: 0 }],
      },
      failingExec,
    );
    const recipe = recipeFromRun(source);
    recipe.schedule = [{ actor: "worker-0", kind: "wake", chosen: 0 }];
    const result = replayRecipe(recipe, source);
    expect(result.outcome).toBe("not-reproduced");
    expect(result.exitStatus).toBe("passed");
    // not-reproduced must never count as a pass.
    expect(result.matchedSignature).toBe(false);
  });

  it("classifies a near-but-different failure as not-reproduced", () => {
    const sourceExec = execute({
      program: "data-race",
      seed: "race-a",
      env: {},
      schedule: [{ actor: "worker-1", kind: "wake", chosen: 0 }],
      args: [],
      tempRoots: [],
    });
    const source = runFromExec(
      {
        testName: "Schedules/counter merge is stable",
        program: "data-race",
        seed: "race-a",
        envWhitelist: {},
        schedule: [{ actor: "worker-1", kind: "wake", chosen: 0 }],
      },
      sourceExec,
    );
    const recipe: ReplayRecipe = {
      ...recipeFromRun(source),
      // worker-0 wakes first (passes the line-42 guard), and the later
      // lock/wake interleaving drives the distinct line-58 failure shape.
      schedule: [
        { actor: "worker-0", kind: "wake", chosen: 0 },
        { actor: "worker-1", kind: "lock-acquire", chosen: 1 },
        { actor: "worker-0", kind: "wake", chosen: 3 },
      ],
    };
    const result = replayRecipe(recipe, source);
    expect(result.exitStatus).toBe("failed");
    expect(result.outcome).toBe("not-reproduced");
    expect(result.reason).toMatch(/签名/);
  });
});

describe("environment compatibility", () => {
  it("missing required env is env-incompatible, never a pass", () => {
    const recipe: ReplayRecipe = {
      id: "r",
      sourceRunId: "s",
      program: "env-sens",
      seed: "x",
      env: {},
      schedule: [],
      args: [],
      tempRoots: [],
      createdAt: "",
    };
    const result = replayRecipe(recipe, {
      testName: "Env/requires modern sdk",
      stdoutSummary: "EnvironmentError: old sdk at env_test.ts:17",
      errorType: "EnvironmentError",
      exitCode: 2,
    });
    expect(result.outcome).toBe("env-incompatible");
    expect(result.reason).toMatch(/REQUIRED_SDK/);
  });

  it("unsupported TIMER_MODE value is env-incompatible", () => {
    const result = execute({
      program: "flaky-timer",
      seed: "x",
      env: { TIMER_MODE: "bogus" },
      schedule: [],
      args: [],
      tempRoots: [],
    });
    expect(result.compatible).toBe(false);
    expect(result.incompatibilityReason).toMatch(/TIMER_MODE/);
  });
});

describe("path and parameter escape rejection", () => {
  const safe = {
    program: "env-sens" as const,
    seed: "x",
    schedule: [],
    args: [] as string[],
    tempRoots: [] as string[],
  };

  it("rejects extra args (no parameter surface beyond the executor)", () => {
    const result = execute({ ...safe, env: {}, args: ["--shell=/bin/sh"] });
    expect(result.compatible).toBe(false);
    expect(result.incompatibilityReason).toMatch(/参数/);
  });

  it("rejects unknown programs", () => {
    const result = execute({
      ...safe,
      program: "rm" as unknown as "env-sens",
      env: {},
    });
    expect(result.compatible).toBe(false);
  });

  it("rejects non-whitelisted env keys", () => {
    const result = execute({
      ...safe,
      env: { LD_PRELOAD: "/tmp/evil.so" },
    });
    expect(result.compatible).toBe(false);
    expect(result.incompatibilityReason).toMatch(/LD_PRELOAD/);
  });

  it("rejects path traversal and escapes outside the temp workspace", () => {
    const traversal = execute({
      ...safe,
      env: { TMPDIR: "/tmp/work/../../etc" },
    });
    expect(traversal.compatible).toBe(false);
    expect(traversal.incompatibilityReason).toMatch(/\.\./);

    const system = execute({
      ...safe,
      env: { TMPDIR: "/etc/cron.d" },
    });
    expect(system.compatible).toBe(false);
    expect(system.incompatibilityReason).toMatch(/临时工作区之外/);
  });

  it("allows absolute temp roots under /tmp and /var/folders", () => {
    for (const dir of ["/tmp/build-x", "/var/folders/zz/work"]) {
      const result = execute({
        ...safe,
        env: { REQUIRED_SDK: "2.3", TMPDIR: dir },
      });
      expect(result.compatible, dir).toBe(true);
    }
  });
});
