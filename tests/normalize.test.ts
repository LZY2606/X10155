import { describe, expect, it } from "vitest";
import { buildSignature, normalizeText, runFingerprint } from "../src/core/normalize.js";
import type { RunRecord } from "../src/core/types.js";

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    testName: "suite/queue-drain",
    status: "fail",
    exitCode: 1,
    stdoutSummary: [
      "FAIL suite/queue-drain",
      "AssertionError: expected queue to be drained",
      "    at drain (src/queue/drain.test.ts:42)",
      "values: leftover=1",
      "took 123ms",
      "worker log: /tmp/job-abc/drain.log",
    ].join("\n"),
    stderrSummary: "",
    seed: 7,
    tempPathPrefixes: ["/tmp/job-abc"],
    ...overrides,
  };
}

describe("噪声归一化规则", () => {
  it("只遮蔽声明过的临时路径与带单位耗时", () => {
    const normalized = normalizeText(run().stdoutSummary, run(), "rules-v1");
    expect(normalized.text).toContain("worker log: <TEMP>/drain.log");
    expect(normalized.text).toContain("took <DURATION>");
    expect(normalized.transforms.map((transform) => transform.ruleId)).toEqual([
      "declared-temp-paths",
      "duration-with-unit",
    ]);
  });

  it("未声明的路径不被遮蔽", () => {
    const record = run({ tempPathPrefixes: [] });
    const normalized = normalizeText(record.stdoutSummary, record, "rules-v1");
    expect(normalized.text).toContain("/tmp/job-abc/drain.log");
  });

  it("行号与断言值保持原样，不会被耗时规则吞掉", () => {
    const normalized = normalizeText(run().stdoutSummary, run(), "rules-v1");
    expect(normalized.text).toContain("drain.test.ts:42");
    expect(normalized.text).toContain("leftover=1");
  });
});

describe("失败签名", () => {
  it("行号 / 错误类型 / 断言值的真实变化产生不同签名", () => {
    const base = buildSignature(run(), "rules-v1");
    const otherLine = buildSignature(run({ stdoutSummary: run().stdoutSummary.replace(":42)", ":43)") }), "rules-v1");
    const otherType = buildSignature(
      run({ stdoutSummary: run().stdoutSummary.replace("AssertionError", "TimeoutError") }),
      "rules-v1",
    );
    const otherValue = buildSignature(
      run({ stdoutSummary: run().stdoutSummary.replace("leftover=1", "leftover=2") }),
      "rules-v1",
    );
    expect(otherLine.signatureHash).not.toBe(base.signatureHash);
    expect(otherType.signatureHash).not.toBe(base.signatureHash);
    expect(otherValue.signatureHash).not.toBe(base.signatureHash);
  });

  it("只有声明路径与耗时不同时签名一致", () => {
    const a = buildSignature(run(), "rules-v1");
    const b = buildSignature(
      run({
        tempPathPrefixes: ["/tmp/job-xyz"],
        stdoutSummary: run().stdoutSummary
          .replaceAll("/tmp/job-abc", "/tmp/job-xyz")
          .replace("took 123ms", "took 9876 milliseconds"),
      }),
      "rules-v1",
    );
    expect(b.signatureHash).toBe(a.signatureHash);
  });
});

describe("规则版本", () => {
  it("v2 归一化进程标识与十六进制地址，v1 视图保持原语义", () => {
    const recordA = run({
      stdoutSummary: run().stdoutSummary.replace("values: leftover=1", "values: leftover=1 pid=10001"),
    });
    const recordB = run({
      tempPathPrefixes: ["/tmp/job-xyz"],
      stdoutSummary: run()
        .stdoutSummary.replaceAll("/tmp/job-abc", "/tmp/job-xyz")
        .replace("values: leftover=1", "values: leftover=1 pid=99999"),
    });
    expect(buildSignature(recordA, "rules-v1").signatureHash).not.toBe(
      buildSignature(recordB, "rules-v1").signatureHash,
    );
    expect(buildSignature(recordA, "rules-v2").signatureHash).toBe(
      buildSignature(recordB, "rules-v2").signatureHash,
    );
  });
});

describe("运行指纹", () => {
  it("同内容指纹一致，环境或种子不同指纹不同", () => {
    expect(runFingerprint(run())).toBe(runFingerprint(run()));
    expect(runFingerprint(run({ seed: 8 }))).not.toBe(runFingerprint(run()));
    expect(runFingerprint(run({ env: { FOO: "1" } }))).not.toBe(runFingerprint(run()));
  });
});
