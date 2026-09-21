import { checkCompatibility } from './compatibility';
import { fakeExecute, isRegisteredTest, requirementsOf } from './executor';
import { signatureForRun } from './normalize';
import type {
  NoisePolicy,
  ReplayRecipe,
  ReplayResult,
  RunRecord,
} from './types';

export class ReplayRejectedError extends Error {}

/**
 * 在确定性假执行器上重放配方。
 * 结果三分类：reproduced / not-reproduced / environment-incompatible。
 * 后两者绝不会被算作“通过”：not-reproduced 覆盖“退出码不同”与“失败签名不同”。
 */
export function replayRecipe(
  recipe: ReplayRecipe,
  policy: NoisePolicy,
  now: () => Date = () => new Date(),
): ReplayResult {
  if (!isRegisteredTest(recipe.testId)) {
    throw new ReplayRejectedError(`拒绝重放：${recipe.testId} 不是注册的假执行器测试`);
  }

  const incompatibilities = checkCompatibility(
    // 需求由注册测试提供，而非配方自带，防止配方自证兼容。
    requirementsOf(recipe.testId),
  );

  const ranAt = now().toISOString();

  if (incompatibilities.length > 0) {
    return {
      outcome: 'environment-incompatible',
      exitStatus: -1,
      stdoutSummary: '',
      observedSignature: null,
      targetSignature: recipe.targetSignature,
      incompatibilities,
      virtualTime: [],
      durationMs: 0,
      ranAt,
    };
  }

  const output = fakeExecute(recipe.testId, {
    seed: recipe.seed,
    env: recipe.env,
    schedule: recipe.schedule,
  });

  const runRecord: RunRecord = {
    id: `replay:${recipe.id}:${ranAt}`,
    testName: `${recipe.testId} > replay`,
    exitStatus: output.exitStatus,
    stdoutSummary: output.stdoutSummary,
    seed: recipe.seed,
    env: recipe.env,
    virtualTime: output.virtualTime,
    schedule: recipe.schedule,
    durationMs: output.durationMs,
    requirements: output.requirements,
    recordedAt: ranAt,
  };

  const observed = signatureForRun(runRecord, policy);
  const reproduced =
    output.exitStatus !== 0 &&
    observed !== null &&
    observed.signature === recipe.targetSignature;

  return {
    outcome: reproduced
      ? 'reproduced'
      : 'not-reproduced',
    exitStatus: output.exitStatus,
    stdoutSummary: output.stdoutSummary,
    observedSignature: observed?.signature ?? null,
    targetSignature: recipe.targetSignature,
    incompatibilities: [],
    virtualTime: output.virtualTime,
    durationMs: output.durationMs,
    ranAt,
  };
}
