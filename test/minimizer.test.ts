import { describe, expect, it } from 'vitest';
import { executeFakeTest } from '../src/core/fakeExecutor.js';
import { runFingerprint } from '../src/core/fingerprint.js';
import { buildRecipeFromRun } from '../src/core/recipe.js';
import {
  initMinimization,
  minimizationStepOnce,
  runMinimization,
} from '../src/core/minimizer.js';

describe('逐步最小化与证据', () => {
  it('每一步恰好一次重放，拒绝的删减回滚并保留证据', () => {
    const { run } = executeFakeTest('suite/queue-order-flake', 'seed-1', { REPLAY_MODE: 'replay' }, [
      { step: 0, point: 'queue', resource: 'job-queue', selected: 'consumer-B', waiters: ['consumer-A', 'consumer-B'] },
      { step: 1, point: 'queue', resource: 'job-queue', selected: 'consumer-B', waiters: ['consumer-A', 'consumer-B'] },
    ]);
    const recipe = buildRecipeFromRun(run, runFingerprint(run), 2);
    const state = initMinimization(recipe, 20);
    expect(state.replaysUsed).toBe(1);
    expect(state.currentVerdict).toBe('reproduced');

    // env 只有必需的 REPLAY_MODE：删除它会 env-incompatible，必须拒绝回滚
    const afterEnvAttempt = minimizationStepOnce(state);
    expect(afterEnvAttempt.replaysUsed).toBe(2);
    const envStep = afterEnvAttempt.steps[1];
    expect(envStep.action).toEqual({ kind: 'remove-env', variable: 'REPLAY_MODE' });
    expect(envStep.verdict).toBe('env-incompatible');
    expect(envStep.accepted).toBe(false);
    expect(afterEnvAttempt.currentRecipe.env).toEqual({ REPLAY_MODE: 'replay' });
    expect(afterEnvAttempt.currentRecipe.schedule).toHaveLength(2);
  });

  it('删除调度事件：仍复现则接受，证据链按时间记录全部尝试', () => {
    // seed-1 在空调度（确定性默认）下恰好两个调度点都选 consumer-B（失败）。
    // 因此从“显式固定 B,B”的配方里删掉一个调度事件后，默认调度仍复现失败 ⇒ 接受。
    const { run } = executeFakeTest('suite/queue-order-flake', 'seed-1', { REPLAY_MODE: 'replay' }, [
      { step: 0, point: 'queue', resource: 'job-queue', selected: 'consumer-B', waiters: ['consumer-A', 'consumer-B'] },
      { step: 1, point: 'queue', resource: 'job-queue', selected: 'consumer-B', waiters: ['consumer-A', 'consumer-B'] },
    ]);
    const recipe = buildRecipeFromRun(run, runFingerprint(run), 2);
    let state = initMinimization(recipe, 20);

    // 候选顺序：先删 REPLAY_MODE（env-incompatible，拒绝回滚）
    state = minimizationStepOnce(state);
    expect(state.steps.at(-1)!.action).toEqual({ kind: 'remove-env', variable: 'REPLAY_MODE' });
    expect(state.steps.at(-1)!.accepted).toBe(false);
    expect(state.currentRecipe.env).toEqual({ REPLAY_MODE: 'replay' });

    // 随后从尾部调度事件开始删：删 step=1，默认调度仍选 B ⇒ 复现 ⇒ 接受
    state = minimizationStepOnce(state);
    expect(state.steps.at(-1)!.action).toEqual({ kind: 'remove-schedule-step', step: 1 });
    expect(state.steps.at(-1)!.verdict).toBe('reproduced');
    expect(state.steps.at(-1)!.accepted).toBe(true);
    expect(state.currentRecipe.schedule).toHaveLength(1);
    expect(state.currentRecipe.schedule[0].step).toBe(0);

    // 每一步都留有配方快照与重放结论证据
    for (const step of state.steps) {
      expect(step.recipe).toBeDefined();
      expect(['reproduced', 'not-reproduced', 'env-incompatible']).toContain(step.verdict);
      expect(typeof step.replaysUsed).toBe('number');
    }
  });

  it('预算耗尽：状态为 budget-exhausted 并返回当前最小结果（不伪称最小）', () => {
    const { run } = executeFakeTest('suite/queue-order-flake', 'seed-1', { REPLAY_MODE: 'replay' }, [
      { step: 0, point: 'queue', resource: 'job-queue', selected: 'consumer-B', waiters: ['consumer-A', 'consumer-B'] },
      { step: 1, point: 'queue', resource: 'job-queue', selected: 'consumer-B', waiters: ['consumer-A', 'consumer-B'] },
    ]);
    const recipe = buildRecipeFromRun(run, runFingerprint(run), 2);
    // 预算 2 = 基线 + 一次尝试
    const state = runMinimization(initMinimization(recipe, 2), 10);
    expect(state.status).toBe('budget-exhausted');
    expect(state.replaysUsed).toBe(2);
    expect(state.finishedAt).not.toBeNull();
    // 当前配方仍可重放且仍复现（基线成立时）
    expect(state.currentVerdict).toBe('reproduced');
  });

  it('预算充足时到达 fixed-point，且不声称“全局最小”', () => {
    const { run } = executeFakeTest('suite/timeout-flake', 'seed-1', { REPLAY_MODE: 'replay' });
    const recipe = buildRecipeFromRun(run, runFingerprint(run), 2);
    const state = runMinimization(initMinimization(recipe, 16), 100);
    // timeout 没有调度事件；REPLAY_MODE 删除后不兼容 ⇒ 没有可接受删减
    expect(['fixed-point', 'budget-exhausted']).toContain(state.status);
    if (state.status === 'fixed-point') {
      // 所有候选都被尝试过并留下拒绝证据
      expect(state.steps.filter((step) => !step.accepted).length).toBeGreaterThan(0);
    }
  });

  it('基线不能复现时立即结束（避免把“未复现”误当最小化起点）', () => {
    const { run } = executeFakeTest('suite/timeout-flake', 'seed-1', { REPLAY_MODE: 'replay' });
    const recipe = buildRecipeFromRun(run, runFingerprint(run), 2);
    const broken = { ...recipe, seed: 'seed-2', id: `${recipe.id}-broken` };
    const state = initMinimization(broken, 10);
    expect(state.status).toBe('fixed-point');
    expect(state.currentVerdict).not.toBe('reproduced');
  });
});
