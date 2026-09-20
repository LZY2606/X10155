import { describe, expect, it } from "vitest";
import { execute } from "../../src/executor/executor";
import { recipeFromRun } from "../../src/core/recipe";
import {
  createSession,
  minimizationTick,
} from "../../src/core/minimize";
import type { TestRun } from "../../src/core/types";
import { runFingerprint } from "../../src/core/fingerprint";

function timerRun(): TestRun {
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
      { actor: "observer-9", kind: "observe" as const, chosen: 0 },
    ],
    args: [] as string[],
    tempRoots: ["/tmp/build-run-001"],
  };
  const exec = execute(request);
  const payload = {
    testName: "Timers/flaky deadline fires on time",
    program: request.program,
    exitStatus: exec.exitStatus,
    exitCode: exec.exitCode,
    errorType: exec.errorType,
    stdoutSummary: exec.stdoutSummary,
    seed: request.seed,
    envWhitelist: request.env,
    virtualTimeEvents: exec.virtualTimeEvents,
    schedule: request.schedule,
    tempRoots: request.tempRoots,
  };
  return {
    id: "timer-source",
    importedAt: new Date(0).toISOString(),
    fingerprint: runFingerprint(payload),
    ...payload,
  };
}

describe("stepwise minimizer", () => {
  it("records evidence for every step and only keeps reproducing deletions", () => {
    const target = timerRun();
    const recipe = recipeFromRun(target);
    const envCount = Object.keys(recipe.env).length;
    const scheduleCount = recipe.schedule.length;
    const total = envCount + scheduleCount;

    let session = createSession({
      id: "session",
      recipe,
      targetRun: target,
      budget: total + 1,
    });
    let current = recipe;
    let attempts = 0;
    while (session.status === "running") {
      const tick = minimizationTick(session, current, target);
      session = tick.session;
      current = tick.recipe;
      if (tick.attempt) attempts++;
    }

    expect(attempts).toBe(total);
    // Every attempted item produced an evidence node and a step.
    expect(session.steps).toHaveLength(total);
    expect(session.evidenceTree.children).toHaveLength(total);
    // TIMER_MODE deletion must be rejected (env-incompatible); the required
    // pin survives in the minimized recipe.
    const timerStep = session.steps.find((s) => s.itemKey === "env:TIMER_MODE");
    expect(timerStep).toBeDefined();
    expect(timerStep?.accepted).toBe(false);
    expect(timerStep?.outcome).toBe("env-incompatible");
    expect(current.env.TIMER_MODE).toBe("virtual");
    // TMPDIR and the extra yield event are pure noise and get removed;
    // RUN_ID shifts the deterministic RNG stream, so deleting it correctly
    // fails to reproduce and is kept (no over-aggressive minimization).
    expect(current.env.TMPDIR).toBeUndefined();
    expect(current.env.RUN_ID).toBe("run-001");
    expect(session.status).toBe("complete");
    expect(session.globalMinimumClaimed).toBe(false);
  });

  it("stops on budget exhaustion and returns the current smallest recipe", () => {
    const target = timerRun();
    const recipe = recipeFromRun(target);
    let session = createSession({
      id: "budgeted",
      recipe,
      targetRun: target,
      budget: 1,
    });
    let current = recipe;
    const tick = minimizationTick(session, current, target);
    session = tick.session;
    current = tick.recipe;

    expect(session.status).toBe("budget-exhausted");
    expect(session.attemptsUsed).toBe(1);
    expect(session.globalMinimumClaimed).toBe(false);
    // Further ticks do nothing and never claim completion.
    const again = minimizationTick(session, current, target);
    expect(again.session.status).toBe("budget-exhausted");
  });

  it("tracks deletions by stable origin ids when earlier events are removed", () => {
    const target = timerRun();
    const recipe = recipeFromRun(target);
    // Three schedule events: the observer event is inessential; removing
    // it must not corrupt identity tracking of the contending decisions.
    expect(recipe.schedule).toHaveLength(3);
    let session = createSession({
      id: "shift",
      recipe,
      targetRun: target,
      budget: 10,
    });
    let current = recipe;
    while (session.status === "running") {
      const tick = minimizationTick(session, current, target);
      session = tick.session;
      current = tick.recipe;
    }
    // Essential contending decisions survive; the passive observer event
    // was deleted even though it sat between them in the recorded array.
    expect(current.schedule.map((d) => d.actor)).toEqual([
      "worker-0",
      "worker-2",
    ]);
    const observeStep = session.steps.find((s) => s.itemKey === "schedule:2");
    expect(observeStep?.accepted).toBe(true);
    const wakeStep = session.steps.find((s) => s.itemKey === "schedule:0");
    expect(wakeStep?.accepted).toBe(false);
  });
});
