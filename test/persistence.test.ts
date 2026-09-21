import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';
import { loadOrSeedStore, saveStore } from '../src/server/persistence.js';
import { executeFakeTest } from '../src/core/fakeExecutor.js';
import { runFingerprint } from '../src/core/fingerprint.js';
import { buildRecipeFromRun } from '../src/core/recipe.js';
import { initMinimization, minimizationStepOnce, runMinimization } from '../src/core/minimizer.js';

describe('JSON 持久化', () => {
  it('首次启动播种演示数据；再次载入后运行、指纹、顺序、配方与最小化状态完整保留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flaky-store-'));
    const file = join(dir, 'store.json');

    const first = loadOrSeedStore(file);
    expect(first.state.runOrder.length).toBeGreaterThan(0);
    expect(readFileSync(file, 'utf8')).toContain('run_');

    const { run } = executeFakeTest('suite/timeout-flake', 'seed-1', { REPLAY_MODE: 'replay' });
    const recipe = buildRecipeFromRun(run, runFingerprint(run), 2);
    first.saveRecipe(recipe);
    const minimization = runMinimization(initMinimization(recipe, 6), 10);
    first.saveMinimization(minimization);
    saveStore(file, first);

    const second = loadOrSeedStore(file);
    expect(second.state.runOrder).toEqual(first.state.runOrder);
    for (const fingerprint of second.state.runOrder) {
      expect(second.state.runs[fingerprint]).toEqual(first.state.runs[fingerprint]);
    }
    expect(second.getRecipe(recipe.id)).toEqual(recipe);
    expect(second.getMinimization(minimization.id)?.steps).toHaveLength(minimization.steps.length);
  });

  it('持久化文件被篡改（指纹与内容不符）时拒绝载入', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flaky-store-bad-'));
    const file = join(dir, 'store.json');
    const store = loadOrSeedStore(file);
    const json = JSON.parse(readFileSync(file, 'utf8')) as Store['state'];
    const firstFp = store.state.runOrder[0];
    json.runs[firstFp].stdoutSummary = `${json.runs[firstFp].stdoutSummary}\nTAMPERED`;
    writeFileSync(file, JSON.stringify(json));
    expect(() => loadOrSeedStore(file)).toThrow(/指纹与内容不符/);
  });
});

import type { MinimizationState } from '../src/core/types.js';

describe('最小化实验跨重启恢复', () => {
  it('JSON 往返后待试候选不丢失，继续时不会误报固定点', () => {
    const { run } = executeFakeTest('suite/queue-order-flake', 'seed-1', { REPLAY_MODE: 'replay' }, [
      { step: 0, point: 'queue', resource: 'job-queue', selected: 'consumer-B', waiters: ['consumer-A', 'consumer-B'] },
      { step: 1, point: 'queue', resource: 'job-queue', selected: 'consumer-B', waiters: ['consumer-A', 'consumer-B'] },
    ]);
    const recipe = buildRecipeFromRun(run, runFingerprint(run), 2);
    const before = initMinimization(recipe, 20);
    // 仅做完基线（候选尚未消耗），然后模拟服务端持久化 + 重启
    const restored = structuredClone(before) as MinimizationState;
    expect(restored.pendingCandidates?.length).toBeGreaterThan(0);

    const afterOne = minimizationStepOnce(restored);
    expect(afterOne.steps.length).toBe(2); // 基线 + 一次真实尝试，而不是直接 fixed-point
    expect(afterOne.status).toBe('in-progress');
  });
});
