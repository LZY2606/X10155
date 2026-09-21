import { describe, expect, it } from "vitest";
import { clusterRuns } from "../src/core/cluster.js";
import { emptyStore, exportNdjson, importNdjson } from "../src/core/store.js";
import { runFingerprint } from "../src/core/normalize.js";
import type { RunRecord } from "../src/core/types.js";

function failureRun(seed: number, tempPrefix: string, line: string, value: number): RunRecord {
  return {
    testName: "suite/queue-drain",
    status: "fail",
    exitCode: 1,
    stdoutSummary: [
      "FAIL suite/queue-drain",
      "AssertionError: expected queue to be drained",
      `    at drain (src/queue/drain.test.ts:${line})`,
      `values: leftover=${value}`,
      `took ${100 + seed}ms`,
      `worker log: ${tempPrefix}/drain.log`,
    ].join("\n"),
    seed,
    tempPathPrefixes: [tempPrefix],
    durationMs: 100 + seed,
    env: {},
    schedule: [],
    virtualTime: [],
  };
}

function stored(runs: RunRecord[]) {
  let store = emptyStore();
  for (const record of runs) {
    store = importNdjson(store, JSON.stringify(record)).state;
  }
  return store;
}

describe("近似但不同的失败", () => {
  it("路径/耗时噪声合并，断言值差异拆分聚类", () => {
    const store = stored([
      failureRun(11, "/tmp/job-1", "42", 1),
      failureRun(13, "/tmp/job-2", "42", 1),
      failureRun(15, "/tmp/job-3", "42", 2),
    ]);
    const views = clusterRuns(store.runs, ["rules-v1"]);
    expect(views).toHaveLength(2);
    expect(views[0]?.members).toHaveLength(2);
    expect(views[1]?.members).toHaveLength(1);
  });
});

describe("稳定聚类", () => {
  it("重算得到相同视图，且成员保持导入顺序", () => {
    const records = [
      failureRun(11, "/tmp/job-1", "42", 1),
      failureRun(15, "/tmp/job-3", "42", 2),
      failureRun(13, "/tmp/job-2", "42", 1),
    ];
    const store = stored(records);
    const first = clusterRuns(store.runs, ["rules-v1"]);
    const second = clusterRuns(store.runs, ["rules-v1"]);
    expect(second).toEqual(first);
    expect(first[0]?.members.map((member) => member.importSeq)).toEqual([0, 2]);
  });

  it("导入导出保持指纹与顺序", () => {
    const records = [failureRun(11, "/tmp/job-1", "42", 1), failureRun(15, "/tmp/job-3", "42", 2)];
    const store = stored(records);
    const ndjson = exportNdjson(store);
    const reimported = importNdjson(emptyStore(), ndjson).state;
    expect(reimported.runs.map((run) => run.fingerprint)).toEqual(
      store.runs.map((run) => run.fingerprint),
    );
    for (const record of records) {
      const line = JSON.parse(JSON.stringify(record)) as RunRecord;
      expect(line.fingerprint).toBeUndefined();
    }
    expect(ndjson).toContain(runFingerprint(records[0]!));
  });

  it("坏行报错但不阻断其他行；重复指纹被跳过", () => {
    const good = failureRun(11, "/tmp/job-1", "42", 1);
    const text = [JSON.stringify(good), "{not json", JSON.stringify(good)].join("\n");
    const report = importNdjson(emptyStore(), text);
    expect(report.imported).toHaveLength(1);
    expect(report.duplicates).toBe(1);
    expect(report.errors[0]?.line).toBe(2);
  });

  it("指纹与内容不一致的行被拒绝", () => {
    const record = failureRun(11, "/tmp/job-1", "42", 1);
    const tampered = JSON.stringify({ ...record, fingerprint: "run-bogus" });
    const report = importNdjson(emptyStore(), tampered);
    expect(report.imported).toHaveLength(0);
    expect(report.errors[0]?.error).toContain("指纹");
  });
});
