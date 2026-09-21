import { FAKE_TESTS, replayRecipe } from './fakeExecutor.js';
import { fnv1a64Hex } from './hash.js';
import type {
  MinimizationState,
  MinimizationStep,
  ReplayOutcome,
  ReplayRecipe,
} from './types.js';

/**
 * 逐步（一次删减一个环境项或调度事件）最小化重放配方。
 *
 *  - 每一步只做一次重放，完整保留尝试前后的配方快照与结论（证据树按时间排列）。
 *  - 删减后仍复现才接受；not-reproduced / env-incompatible 都不是成功，回滚。
 *  - 预算按重放次数计；预算耗尽立即返回“当前最小结果”，状态标为 budget-exhausted，
 *    绝不宣称全局最小。
 *  - 无可删项时达到 fixed-point（相对于这套删减操作的局部最小）。
 */

export const DEFAULT_BUDGET = 32;

type Candidate =
  | { kind: 'remove-env'; variable: string }
  | { kind: 'remove-schedule-step'; step: number };

function candidateOrder(recipe: ReplayRecipe): Candidate[] {
  const definition = FAKE_TESTS[recipe.fakeTest];
  const required = new Set(definition.requiredEnvKeys);
  const envKeys = Object.keys(recipe.env).sort((a, b) => {
    const ar = required.has(a) ? 1 : 0;
    const br = required.has(b) ? 1 : 0;
    if (ar !== br) {
      return ar - br; // 非必需项先删
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const scheduleSteps = recipe.schedule
    .map((decision) => decision.step)
    .sort((a, b) => b - a); // 从尾部事件开始删，更容易保持触发结构
  return [
    ...envKeys.map((variable) => ({ kind: 'remove-env' as const, variable })),
    ...scheduleSteps.map((step) => ({ kind: 'remove-schedule-step' as const, step })),
  ];
}

function applyCandidate(recipe: ReplayRecipe, candidate: Candidate): ReplayRecipe {
  const clone: ReplayRecipe = {
    ...recipe,
    env: { ...recipe.env },
    schedule: recipe.schedule.map((decision) => ({ ...decision, waiters: [...decision.waiters] })),
  };
  if (candidate.kind === 'remove-env') {
    delete clone.env[candidate.variable];
  } else {
    clone.schedule = clone.schedule.filter((decision) => decision.step !== candidate.step);
  }
  return clone;
}

export function initMinimization(recipe: ReplayRecipe, budget: number = DEFAULT_BUDGET): MinimizationState {
  const baselineOutcome: ReplayOutcome = replayRecipe(recipe, recipe.rulesetVersion);
  const now = new Date(0).toISOString();
  const baselineStep: MinimizationStep = {
    index: 0,
    action: { kind: 'baseline' },
    recipe: recipe,
    verdict: baselineOutcome.verdict,
    accepted: true,
    replaysUsed: 1,
  };

  const state: MinimizationState = {
    id: `min_${fnv1a64Hex(`min:${recipe.id}:${budget}`)}`,
    recipeId: recipe.id,
    steps: [baselineStep],
    currentRecipe: recipe,
    currentVerdict: baselineOutcome.verdict,
    replaysUsed: 1,
    budget,
    status: 'in-progress',
    startedAt: now,
    finishedAt: null,
  };

  if (baselineOutcome.verdict !== 'reproduced') {
    state.status = 'fixed-point';
    state.finishedAt = now;
    state.pendingCandidates = [];
    return state;
  }

  state.pendingCandidates = candidateOrder(recipe);
  return refreshStatus(state);
}

/** 执行一步删减尝试（恰好一次重放）。已结束则原样返回。 */
export function minimizationStepOnce(state: MinimizationState): MinimizationState {
  if (state.status !== 'in-progress') {
    return state;
  }

  let candidates = state.pendingCandidates ?? [];
  const candidate = candidates.shift();
  if (!candidate) {
    state.status = 'fixed-point';
    state.finishedAt = new Date(0).toISOString();
    state.pendingCandidates = [];
    return state;
  }

  const candidateRecipe = applyCandidate(state.currentRecipe, candidate);
  const outcome = replayRecipe(candidateRecipe, candidateRecipe.rulesetVersion);
  state.replaysUsed += 1;

  const accepted = outcome.verdict === 'reproduced';
  const step: MinimizationStep = {
    index: state.steps.length,
    action: candidate,
    recipe: candidateRecipe,
    verdict: outcome.verdict,
    accepted,
    replaysUsed: state.replaysUsed,
  };
  state.steps.push(step);

  if (accepted) {
    state.currentRecipe = candidateRecipe;
    state.currentVerdict = outcome.verdict;
    candidates = candidateOrder(candidateRecipe);
  }

  state.pendingCandidates = candidates;

  if (state.replaysUsed >= state.budget) {
    state.status = 'budget-exhausted';
    state.finishedAt = new Date(0).toISOString();
    return state;
  }

  return refreshStatus(state);
}

function refreshStatus(state: MinimizationState): MinimizationState {
  const candidates = state.pendingCandidates ?? [];
  if (candidates.length === 0 && state.status === 'in-progress') {
    state.status = 'fixed-point';
    state.finishedAt = new Date(0).toISOString();
    state.pendingCandidates = [];
  }
  return state;
}

/** 连续执行至多 maxSteps 步（测试 / 批量“继续”用）。 */
export function runMinimization(
  state: MinimizationState,
  maxSteps: number = Number.POSITIVE_INFINITY,
): MinimizationState {
  let current = state;
  let steps = 0;
  while (current.status === 'in-progress' && steps < maxSteps) {
    current = minimizationStepOnce(current);
    steps += 1;
  }
  return current;
}
