import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Recipe, RunRecord } from "../core/types.js";
import type { ExecutorManifest } from "../core/replay.js";
import { validateRecipeInvocation } from "../core/validate.js";

const execFileAsync = promisify(execFile);

export const EXECUTOR_PATH = path.resolve("executor/fake-test.mjs");
export const RECIPE_TMP_DIR = path.resolve("data/tmp");

export async function loadManifest(): Promise<ExecutorManifest> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [EXECUTOR_PATH, "--manifest"],
    { timeout: 5000 },
  );
  return JSON.parse(stdout.trim()) as ExecutorManifest;
}

// 只允许通过随项目提交的假执行器运行配方；拒绝任何越界的路径或参数。
export async function executeRecipe(recipe: Recipe): Promise<RunRecord> {
  const check = validateRecipeInvocation(recipe, EXECUTOR_PATH, RECIPE_TMP_DIR);
  if (!check.ok) {
    throw new Error(`配方被拒绝：${check.reason}`);
  }
  mkdirSync(RECIPE_TMP_DIR, { recursive: true });
  const recipeFile = path.join(RECIPE_TMP_DIR, `recipe-${recipe.id}.json`);
  writeFileSync(
    recipeFile,
    JSON.stringify({
      testName: recipe.testName,
      seed: recipe.seed,
      env: recipe.env,
      schedule: recipe.schedule,
      virtualTimeEvents: recipe.virtualTimeEvents,
    }),
  );
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [EXECUTOR_PATH, "--recipe", recipeFile],
      { timeout: 5000 },
    );
    return JSON.parse(stdout.trim()) as RunRecord;
  } catch (err: unknown) {
    // 假执行器以退出码 1 表示测试失败，但 stdout 仍携带运行记录
    const e = err as { stdout?: string };
    if (typeof e.stdout === "string" && e.stdout.trim().startsWith("{")) {
      return JSON.parse(e.stdout.trim()) as RunRecord;
    }
    throw err;
  }
}
