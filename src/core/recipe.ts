import { randomUUID } from 'node:crypto';
import type { ReplayRecipe, StoredRun } from './types.js';
import { fakeTestBinPath } from './executor.js';

/** 从一条运行建立重放配方：固定种子、环境白名单与调度决策。 */
export function recipeFromRun(run: StoredRun, rootDir: string): ReplayRecipe {
  return {
    id: randomUUID(),
    runId: run.fingerprint,
    createdAt: new Date().toISOString(),
    command: fakeTestBinPath(rootDir),
    args: ['--test', run.testName],
    seed: run.seed,
    env: { ...run.env },
    platform: run.platform,
    declaredTempPaths: [...run.declaredTempPaths],
    virtualTime: [...run.virtualTime],
    schedule: [...run.schedule],
  };
}

/** 从配方提取测试名（参数白名单保证 args[1] 即测试名）。 */
export function testNameOf(recipe: ReplayRecipe): string {
  return recipe.args[1] ?? '';
}
