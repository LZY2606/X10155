// 生成 examples/sample-runs.ndjson：与 executor/fake-test.mjs 的确定性模型一致，
// 但在 stdout 里注入持续时间 / 临时路径噪声，用于演示归一化与聚类。
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function failStdout(testName, seed, { duration, tmp }) {
  const expected = 40 + (seed % 5);
  const line = 100 + (seed % 50);
  return [
    `FAIL ${testName}`,
    `AssertionError: expected ${expected} to equal ${expected + 1}`,
    `    at ${testName}.spec.ts:${line}`,
    `tmp dir: ${tmp}`,
    `completed in ${duration}`,
  ].join("\n");
}

const flakyEnv = {
  FLAKY_MODE: "1",
  TZ: "UTC",
  LOCALE: "en_US",
  FEATURE_X: "off",
};
const flakySchedule = [
  "boot:main",
  "spawn:worker-1",
  "race:worker-2",
  "io:flush",
  "join:all",
];

const runs = [
  // 簇 A：同一份失败核心（seed 42），噪声不同
  {
    id: "run-a1",
    testName: "cart/checkout",
    exitStatus: 1,
    stdout: failStdout("cart/checkout", 42, {
      duration: "142ms",
      tmp: "/tmp/flaky-f519f723",
    }),
    seed: 42,
    env: { ...flakyEnv },
    virtualTimeEvents: ["tick:100", "tick:200"],
    schedule: [...flakySchedule],
  },
  {
    id: "run-a2",
    testName: "cart/checkout",
    exitStatus: 1,
    stdout: failStdout("cart/checkout", 42, {
      duration: "1.7s",
      tmp: "/tmp/flaky-0000abcd",
    }),
    seed: 42,
    env: { ...flakyEnv, LOCALE: "zh_CN" },
    virtualTimeEvents: ["tick:100"],
    schedule: [...flakySchedule],
  },
  {
    id: "run-a3",
    testName: "cart/checkout",
    exitStatus: 1,
    stdout: failStdout("cart/checkout", 42, {
      duration: "980ms",
      tmp: "/var/folders/9x/T/flaky-tmp-7",
    }),
    seed: 42,
    env: { ...flakyEnv },
    virtualTimeEvents: [],
    schedule: [...flakySchedule],
  },
  // 簇 B：近似但不同的失败（断言值与行号不同，seed 44）
  {
    id: "run-b1",
    testName: "cart/checkout",
    exitStatus: 1,
    stdout: failStdout("cart/checkout", 44, {
      duration: "144ms",
      tmp: "/tmp/flaky-cafe0044",
    }),
    seed: 44,
    env: { ...flakyEnv },
    virtualTimeEvents: [],
    schedule: [...flakySchedule],
  },
  {
    id: "run-b2",
    testName: "cart/checkout",
    exitStatus: 1,
    stdout: failStdout("cart/checkout", 44, {
      duration: "2.1s",
      tmp: "/tmp/flaky-dead0044",
    }),
    seed: 44,
    env: { ...flakyEnv, FEATURE_X: "on" },
    virtualTimeEvents: [],
    schedule: [...flakySchedule],
  },
  // 簇 C：不同错误类型
  {
    id: "run-c1",
    testName: "auth/login",
    exitStatus: 1,
    stdout: [
      "FAIL auth/login",
      "TypeError: cannot read properties of undefined",
      "    at auth/login.spec.ts:57",
      "tmp dir: /tmp/flaky-9c9c9c",
      "completed in 88ms",
    ].join("\n"),
    seed: 7,
    env: { FLAKY_MODE: "0", TZ: "UTC" },
    virtualTimeEvents: [],
    schedule: ["boot:main"],
  },
  // 通过的运行（不参与失败聚类）
  {
    id: "run-p1",
    testName: "cart/checkout",
    exitStatus: 0,
    stdout: "ok cart/checkout\ncompleted in 130ms",
    seed: 41,
    env: { FLAKY_MODE: "0", TZ: "UTC" },
    virtualTimeEvents: [],
    schedule: ["boot:main", "join:all"],
  },
  {
    id: "run-p2",
    testName: "auth/login",
    exitStatus: 0,
    stdout: "ok auth/login\ncompleted in 64ms",
    seed: 3,
    env: { FLAKY_MODE: "0" },
    virtualTimeEvents: [],
    schedule: ["boot:main"],
  },
];

const out = runs.map((r) => JSON.stringify(r)).join("\n") + "\n";
mkdirSync(path.join(root, "examples"), { recursive: true });
writeFileSync(path.join(root, "examples", "sample-runs.ndjson"), out);
console.log(`wrote ${runs.length} runs to examples/sample-runs.ndjson`);
