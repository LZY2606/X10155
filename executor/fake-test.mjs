#!/usr/bin/env node
// 确定性假测试执行器：随项目提交，演示与重放不需要运行任意用户命令。
// 用法:
//   node executor/fake-test.mjs --manifest
//   node executor/fake-test.mjs --recipe RECIPE_JSON_PATH
// 输出: 单行 JSON 的运行记录 (RunRecord)。
import { readFileSync } from "node:fs";

const SUPPORTED_ENV = ["FLAKY_MODE", "TZ", "LOCALE", "FEATURE_X"];

function printManifest() {
  process.stdout.write(
    JSON.stringify({
      name: "fake-test-executor",
      version: 1,
      supportedEnv: SUPPORTED_ENV,
    }) + "\n",
  );
}

function fail(message, code = 2) {
  process.stderr.write(message + "\n");
  process.exit(code);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--manifest") {
    printManifest();
    return;
  }
  if (args.length !== 2 || args[0] !== "--recipe") {
    fail("usage: fake-test.mjs --manifest | --recipe FILE");
  }
  let recipe;
  try {
    recipe = JSON.parse(readFileSync(args[1], "utf8"));
  } catch (err) {
    fail(`cannot read recipe: ${err.message}`);
  }
  const env = recipe.env ?? {};
  const unsupported = Object.keys(env).filter(
    (k) => !SUPPORTED_ENV.includes(k),
  );
  if (unsupported.length > 0) {
    process.stdout.write(
      JSON.stringify({
        envIncompatible: true,
        unsupported,
      }) + "\n",
    );
    process.exit(3);
  }

  const seed = Number(recipe.seed) || 0;
  const schedule = Array.isArray(recipe.schedule) ? recipe.schedule : [];
  const testName = String(recipe.testName ?? "unknown");
  const durationMs = 100 + (seed % 200);
  const tmpDir = `/tmp/flaky-${((seed * 2654435761) % 0xffffffff).toString(16)}`;

  const flaky =
    env.FLAKY_MODE === "1" &&
    schedule.some((e) => String(e).startsWith("race:")) &&
    seed % 2 === 0;

  let exitStatus;
  let stdout;
  if (flaky) {
    const expected = 40 + (seed % 5);
    const line = 100 + (seed % 50);
    exitStatus = 1;
    stdout = [
      `FAIL ${testName}`,
      `AssertionError: expected ${expected} to equal ${expected + 1}`,
      `    at ${testName}.spec.ts:${line}`,
      `tmp dir: ${tmpDir}`,
      `completed in ${durationMs}ms`,
    ].join("\n");
  } else {
    exitStatus = 0;
    stdout = [`ok ${testName}`, `completed in ${durationMs}ms`].join("\n");
  }

  process.stdout.write(
    JSON.stringify({
      testName,
      exitStatus,
      stdout,
      seed,
      env,
      virtualTimeEvents: recipe.virtualTimeEvents ?? [],
      schedule,
    }) + "\n",
  );
  process.exit(exitStatus === 0 ? 0 : 1);
}

main();
