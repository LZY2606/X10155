import { describe, expect, it } from "vitest";
import { clusterRuns, diffSummaries, isFailing } from "../../src/core/cluster";
import type { TestRun } from "../../src/core/types";
import { runFingerprint } from "../../src/core/fingerprint";

let counter = 0;
function makeRun(partial: Partial<TestRun>): TestRun {
  const base: Omit<TestRun, "fingerprint"> = {
    id: `run-${counter++}`,
    testName: partial.testName ?? "T",
    program: "data-race",
    exitStatus: partial.exitStatus ?? "failed",
    exitCode: partial.exitCode ?? 1,
    errorType: partial.errorType ?? "AssertionError",
    stdoutSummary: partial.stdoutSummary ?? "x",
    seed: partial.seed ?? "s",
    envWhitelist: partial.envWhitelist ?? {},
    virtualTimeEvents: partial.virtualTimeEvents ?? [],
    schedule: partial.schedule ?? [],
    tempRoots: partial.tempRoots ?? [],
    importedAt: new Date(0).toISOString(),
  };
  const payload = {
    testName: base.testName,
    program: base.program,
    exitStatus: base.exitStatus,
    exitCode: base.exitCode,
    errorType: base.errorType,
    stdoutSummary: base.stdoutSummary,
    seed: base.seed,
    envWhitelist: base.envWhitelist,
    virtualTimeEvents: base.virtualTimeEvents,
    schedule: base.schedule,
    tempRoots: base.tempRoots,
  };
  return { ...base, fingerprint: runFingerprint(payload) };
}

describe("stable clustering", () => {
  it("members stay in import order and clusters order deterministically", () => {
    const runs = [
      makeRun({ id: "a", stdoutSummary: "noise /tmp/1 at t.ts:1" }),
      makeRun({ id: "b", stdoutSummary: "noise /tmp/2 at t.ts:1" }),
      makeRun({
        id: "pass",
        exitStatus: "passed",
        exitCode: 0,
        errorType: undefined,
        stdoutSummary: "ok",
      }),
    ];
    const first = clusterRuns(runs, "v1");
    const second = clusterRuns([...runs].reverse(), "v1");
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    // Reverse import order -> reversed member order preserved.
    expect(first[0].memberIds).toEqual(["run-0", "run-1"]);
    expect(second[0].memberIds).toEqual(["run-1", "run-0"]);
    expect(isFailing(runs[2])).toBe(false);
  });

  it("cluster ids are version scoped and stable", () => {
    const runs = [makeRun({ stdoutSummary: "pid=1 at t.ts:9" })];
    const v1 = clusterRuns(runs, "v1")[0];
    const v2 = clusterRuns(runs, "v2")[0];
    expect(v1.id).toMatch(/^v1-/);
    expect(v2.id).toMatch(/^v2-/);
    expect(v1.id).not.toBe(v2.id);
  });

  it("diff surfaces line/value changes", () => {
    const tokens = diffSummaries("at t.ts:42 got 2", "at t.ts:58 got 7");
    expect(tokens.some((t) => t.kind === "removed" && t.value === "42")).toBe(
      true,
    );
    expect(tokens.some((t) => t.kind === "added" && t.value === "58")).toBe(
      true,
    );
  });
});
