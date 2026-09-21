import { executeFakeTest, HOST_CAPABILITIES, validateRecipeCommand } from './executor.js';
import { testNameOf } from './recipe.js';
import { computeSignature } from './signature.js';
import type {
  ReplayOutcome,
  ReplayRecipe,
  Ruleset,
  StoredRun,
} from './types.js';

/** 环境兼容性检查：平台与 env 白名单键都必须落在宿主能力内。 */
export function checkEnvironment(recipe: ReplayRecipe): ReplayOutcome | null {
  if (recipe.platform !== HOST_CAPABILITIES.platform) {
    return {
      kind: 'environment_incompatible',
      reproduced: false,
      reason: `平台不兼容: 配方需要 ${recipe.platform}，宿主为 ${HOST_CAPABILITIES.platform}`,
    };
  }
  for (const key of Object.keys(recipe.env)) {
    if (!(HOST_CAPABILITIES.envKeys as readonly string[]).includes(key)) {
      return {
        kind: 'environment_incompatible',
        reproduced: false,
        reason: `环境变量 ${key} 不在宿主白名单内`,
      };
    }
  }
  return null;
}

/**
 * 重放配方并与原始运行的失败签名比对。
 * 结果三选一：reproduced / not_reproduced / environment_incompatible，
 * 后两者都不得算通过（reproduced=false）。
 */
export function replayRecipe(
  recipe: ReplayRecipe,
  original: StoredRun,
  ruleset: Ruleset,
  rootDir: string,
): ReplayOutcome {
  const validation = validateRecipeCommand(recipe.command, recipe.args, rootDir);
  if (!validation.ok) {
    return {
      kind: 'environment_incompatible',
      reproduced: false,
      reason: `配方被拒绝: ${validation.reason}`,
    };
  }
  const incompatible = checkEnvironment(recipe);
  if (incompatible) return incompatible;

  const actual = executeFakeTest({
    testName: testNameOf(recipe),
    seed: recipe.seed,
    env: recipe.env,
    virtualTime: recipe.virtualTime,
    schedule: recipe.schedule,
  });
  const actualSignature = computeSignature(
    {
      testName: testNameOf(recipe),
      exitStatus: actual.exitStatus,
      stdout: actual.stdout,
      seed: recipe.seed,
      env: recipe.env,
      platform: recipe.platform,
      declaredTempPaths: recipe.declaredTempPaths,
      virtualTime: recipe.virtualTime,
      schedule: recipe.schedule,
    },
    ruleset,
  );
  const originalSignature = computeSignature(original, ruleset);
  const reproduced = actualSignature.hash === originalSignature.hash;
  return {
    kind: reproduced ? 'reproduced' : 'not_reproduced',
    reproduced,
    reason: reproduced
      ? '重放输出与原始失败签名一致'
      : '重放输出的失败签名与原始运行不同',
    actual,
  };
}
