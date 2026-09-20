import { describe, expect, it } from "vitest";
import {
  activeRules,
  failureSignature,
  normalizeSummary,
} from "../../src/core/normalize";
import type { TestRun } from "../../src/core/types";

function run(summary: string, tempRoots: string[] = []): TestRun {
  return {
    id: "r",
    testName: "T",
    program: "flaky-timer",
    exitStatus: "failed",
    exitCode: 1,
    errorType: "AssertionError",
    stdoutSummary: summary,
    seed: "s",
    envWhitelist: {},
    virtualTimeEvents: [],
    schedule: [],
    tempRoots,
    importedAt: "",
    fingerprint: "",
  };
}

describe("noise normalization rules", () => {
  it("collapses declared temp roots including generated file names", () => {
    const result = normalizeSummary(
      "open /private/ci/work-1234/sub/a.log failed",
      "v1",
      ["/private/ci/work-1234"],
    );
    expect(result.text).toBe("open <TMPROOT> failed");
    expect(result.ruleHits["temp-declared-root"]).toBe(1);
  });

  it("collapses system tmp path shapes and durations and hex addresses", () => {
    const result = normalizeSummary(
      "trace /var/folders/x/y tmp at 0xabcd took 12.5ms elapsed=9000us",
      "v1",
    );
    expect(result.text).toContain("<TMPPATH>");
    expect(result.text).toContain("<ADDR>");
    expect(result.text).toContain("took <DURATION>");
    expect(result.text).toContain("elapsed=<DURATION>");
  });

  it("keeps line numbers, error types and bare assertion values", () => {
    const summary =
      "AssertionError: mismatch at foo_test.ts:42\n  expected 4ms, got 9ms";
    const result = normalizeSummary(summary, "v1");
    expect(result.text).toContain("foo_test.ts:42");
    expect(result.text).toContain("AssertionError");
    // Bare values with no timing keyword must survive.
    expect(result.text).toContain("expected 4ms, got 9ms");
  });
});

describe("rule versions", () => {
  it("v1 leaves pid/uuid untouched; v2 collapses them", () => {
    const summary =
      "boom pid=48213 job 3f2504e0-4f89-11d3-9a0c-0305e82c3301 at f.ts:8";
    const v1 = normalizeSummary(summary, "v1");
    const v2 = normalizeSummary(summary, "v2");
    expect(v1.text).toContain("pid=48213");
    expect(v1.text).toContain("3f2504e0");
    expect(v2.text).toContain("pid=<PID>");
    expect(v2.text).toContain("<UUID>");
    // Shared v1 rule set identical across versions.
    expect(activeRules("v1").map((r) => r.id)).not.toContain("pid-v2");
    expect(activeRules("v2").map((r) => r.id)).toContain("pid-v2");
  });

  it("new rules only add a view: v1 signature stable after v2 exists", () => {
    const a = run("AssertionError: x pid=1 at f.ts:1");
    const b = run("AssertionError: x pid=2 at f.ts:1");
    expect(failureSignature(a, "v1").signature).not.toBe(
      failureSignature(b, "v1").signature,
    );
    expect(failureSignature(a, "v2").signature).toBe(
      failureSignature(b, "v2").signature,
    );
  });
});

describe("near-but-different failures", () => {
  it("line number changes split signatures", () => {
    const a = failureSignature(run("E: v at t.ts:10"), "v1");
    const b = failureSignature(run("E: v at t.ts:11"), "v1");
    expect(a.signature).not.toBe(b.signature);
  });

  it("assertion value changes split signatures", () => {
    const a = failureSignature(run("expected 1, got 2"), "v1");
    const b = failureSignature(run("expected 1, got 3"), "v1");
    expect(a.signature).not.toBe(b.signature);
  });

  it("error type changes split signatures", () => {
    const a = failureSignature(
      { ...run("same words"), errorType: "AssertionError" },
      "v1",
    );
    const b = failureSignature(
      { ...run("same words"), errorType: "TimeoutError" },
      "v1",
    );
    expect(a.signature).not.toBe(b.signature);
  });

  it("noise-only changes keep signatures stable", () => {
    const a = failureSignature(
      run("trace /tmp/a/x 0xaaaa took 10ms at t.ts:7", ["/tmp/a"]),
      "v1",
    );
    const b = failureSignature(
      run("trace <TMPROOT> 0xbbbb took 99ms at t.ts:7"),
      "v1",
    );
    // First one normalizes to same form (root + address + duration).
    expect(a.normalizedSummary).toBe(b.normalizedSummary);
    expect(a.signature).toBe(b.signature);
  });
});
