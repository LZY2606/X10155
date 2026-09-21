import { recipeId, replayRecipe, validateRecipeRequest, FAKE_TESTS } from './fakeExecutor.js';
import { LATEST_RULESET_VERSION } from './normalizer.js';
import { signatureForRun } from './signature.js';
import type {
  FakeTestId,
  ReplayOutcome,
  ReplayRecipe,
  RunRecord,
} from './types.js';

export class RecipeBuildError extends Error {}

/**
 * 从一条原始运行建立重放配方：
 *  - 测试名必须是假执行器内置测试（否则无法在安全边界内重放）；
 *  - 固定种子、该测试白名单认可的环境项、完整调度轨迹；
 *  - 失败运行固定期望签名；通过运行固定“期望通过”。
 */
export function buildRecipeFromRun(
  run: RunRecord,
  fingerprint: string,
  rulesetVersion: number = LATEST_RULESET_VERSION,
): ReplayRecipe {
  const fakeTest = run.testName as FakeTestId;
  const definition = FAKE_TESTS[fakeTest];
  if (!definition) {
    throw new RecipeBuildError(
      `测试 ${run.testName} 不属于随项目提交的假执行器，无法生成重放配方（系统不会执行任意命令）`,
    );
  }

  // 只固定该测试白名单内的环境项，其余导入记录里的环境不进配方。
  const env: Record<string, string> = {};
  for (const key of definition.allowedEnvKeys) {
    if (Object.prototype.hasOwnProperty.call(run.envWhitelist, key)) {
      env[key] = run.envWhitelist[key];
    }
  }

  const signature = run.exitStatus === 0 ? null : signatureForRun(run, rulesetVersion);

  const draft: Omit<ReplayRecipe, 'id'> = {
    sourceRunFingerprint: fingerprint,
    rulesetVersion,
    fakeTest,
    seed: run.seed,
    env,
    schedule: run.scheduleDecisions.map((decision) => ({ ...decision, waiters: [...decision.waiters] })),
    expectedFailureHash: signature ? signature.hash : null,
    expectedExitStatus: run.exitStatus,
    createdAt: new Date(0).toISOString(),
  };

  // 建立配方时同样走边界校验，非法内容直接拒绝。
  validateRecipeRequest(draft.fakeTest, draft.env, draft.schedule);

  return { ...draft, id: recipeId(draft) };
}

export function replayWithRecipe(recipe: ReplayRecipe): ReplayOutcome {
  return replayRecipe(recipe, recipe.rulesetVersion);
}
