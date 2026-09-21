import { describe, expect, it } from 'vitest';
import {
  ExecutorBoundaryError,
  executeFakeTest,
  FAKE_TESTS,
  replayRecipe,
  validateRecipeRequest,
} from '../src/core/fakeExecutor.js';
import { buildRecipeFromRun } from '../src/core/recipe.js';
import { runFingerprint } from '../src/core/fingerprint.js';
import type { PinnedDecision } from '../src/core/types.js';

const BOTH_B: PinnedDecision[] = [
  { step: 0, point: 'queue', resource: 'job-queue', selected: 'consumer-B', waiters: ['consumer-A', 'consumer-B'] },
  { step: 1, point: 'queue', resource: 'job-queue', selected: 'consumer-B', waiters: ['consumer-A', 'consumer-B'] },
];

describe('确定性假执行器与重放', () => {
  it('相同 (测试,种子,环境,调度) 重放结果逐字节确定', () => {
    const first = executeFakeTest('suite/queue-order-flake', 'seed-1', { REPLAY_MODE: 'replay' }, BOTH_B);
    const second = executeFakeTest('suite/queue-order-flake', 'seed-1', { REPLAY_MODE: 'replay' }, BOTH_B);
    expect(first.run).toEqual(second.run);
    expect(first.run.exitStatus).toBe(1);
  });

  it('从失败运行建立配方并重放：复现', () => {
    const { run } = executeFakeTest('suite/queue-order-flake', 'seed-1', { REPLAY_MODE: 'replay' }, BOTH_B);
    const recipe = buildRecipeFromRun(run, runFingerprint(run), 2);
    const outcome = replayRecipe(recipe, 2);
    expect(outcome.verdict).toBe('reproduced');
    expect(outcome.exitStatus).toBe(1);
  });

  it('改变种子导致失败消失：未复现，且不计为通过', () => {
    const { run } = executeFakeTest('suite/timeout-flake', 'seed-1', { REPLAY_MODE: 'replay' });
    const recipe = buildRecipeFromRun(run, runFingerprint(run), 2);
    // seed-22 在假执行器上确定落在阈值内（确定性）。
    const candidates = ['seed-22'];
    const passingSeed = candidates.find((seed) =>
      executeFakeTest('suite/timeout-flake', seed, { REPLAY_MODE: 'replay' }).run.exitStatus === 0,
    );
    expect(passingSeed).toBeDefined();
    const altered = { ...recipe, seed: passingSeed!, id: `${recipe.id}-altered` };
    const outcome = replayRecipe(altered, 2);
    expect(['not-reproduced', 'reproduced']).not.toContain('pass');
    expect(outcome.verdict).toBe('not-reproduced');
  });

  it('缺少 REPLAY_MODE：环境不兼容（不是未复现，更不是通过）', () => {
    const { run } = executeFakeTest('suite/timeout-flake', 'seed-1', { REPLAY_MODE: 'replay' });
    const recipe = buildRecipeFromRun(run, runFingerprint(run), 2);
    const strippedEnv: typeof recipe = {
      ...recipe,
      env: {},
      id: `${recipe.id}-no-mode`,
    };
    const outcome = replayRecipe(strippedEnv, 2);
    expect(outcome.verdict).toBe('env-incompatible');
    expect(outcome.envCompat).toEqual({ kind: 'mode-missing' });
  });

  it('不支持的 REPLAY_MODE 与坏数字环境值：环境不兼容', () => {
    const { run } = executeFakeTest('suite/timeout-flake', 'seed-1', { REPLAY_MODE: 'replay' });
    const recipe = buildRecipeFromRun(run, runFingerprint(run), 2);

    const unsupported = replayRecipe(
      { ...recipe, env: { REPLAY_MODE: 'turbo' }, id: `${recipe.id}-turbo` },
      2,
    );
    expect(unsupported.verdict).toBe('env-incompatible');
    expect(unsupported.envCompat.kind).toBe('mode-unsupported');

    const badNumber = replayRecipe(
      { ...recipe, env: { REPLAY_MODE: 'replay', FLAKY_TIMEOUT_MS: 'oops' }, id: `${recipe.id}-badnum` },
      2,
    );
    expect(badNumber.verdict).toBe('env-incompatible');
    expect(badNumber.envCompat).toEqual({
      kind: 'bad-number',
      variable: 'FLAKY_TIMEOUT_MS',
      value: 'oops',
    });
  });

  it('环境开关未打开时 env-gated 测试通过 ⇒ 对失败配方而言是“未复现”', () => {
    const { run } = executeFakeTest(
      'suite/env-gated-flake',
      'seed-1',
      { REPLAY_MODE: 'replay', FLAKY_FEATURE_TOGGLE: 'on' },
    );
    const recipe = buildRecipeFromRun(run, runFingerprint(run), 2);
    const outcome = replayRecipe(
      {
        ...recipe,
        env: { REPLAY_MODE: 'replay' },
        id: `${recipe.id}-off`,
      },
      2,
    );
    expect(outcome.exitStatus).toBe(0);
    expect(outcome.verdict).toBe('not-reproduced');
  });
});

describe('执行器安全边界（拒绝路径/参数越界）', () => {
  it('未知测试被拒绝（绝不执行任意命令）', () => {
    expect(() =>
      validateRecipeRequest('rm -rf /', { REPLAY_MODE: 'replay' }, []),
    ).toThrow(ExecutorBoundaryError);
  });

  it('越权环境键、shell 元字符、.. 路径片段被拒绝', () => {
    expect(() =>
      validateRecipeRequest(
        'suite/queue-order-flake',
        { REPLAY_MODE: 'replay', SECRET_TOKEN: 'x' },
        [],
      ),
    ).toThrow(/不在测试/);
    expect(() =>
      validateRecipeRequest(
        'suite/queue-order-flake',
        { REPLAY_MODE: 'replay; cat /etc/passwd' },
        [],
      ),
    ).toThrow(ExecutorBoundaryError);
    expect(() =>
      validateRecipeRequest(
        'suite/env-gated-flake',
        { REPLAY_MODE: 'replay', FLAKY_TMPDIR: '/tmp/../../etc' },
        [],
      ),
    ).toThrow(ExecutorBoundaryError);
  });

  it('路径类环境值必须落在沙箱根之内（路径逃逸被拒）', () => {
    expect(() =>
      validateRecipeRequest(
        'suite/env-gated-flake',
        { REPLAY_MODE: 'replay', FLAKY_TMPDIR: '/etc' },
        [],
      ),
    ).toThrow(/越出了假执行器沙箱/);

    // 沙箱之内的合法路径可以通过。
    const root = `${process.cwd()}/data/sandbox`;
    expect(() =>
      validateRecipeRequest(
        'suite/env-gated-flake',
        { REPLAY_MODE: 'replay', FLAKY_TMPDIR: `${root}/case-1` },
        [],
      ),
    ).not.toThrow();
  });

  it('引用不存在的调度点或执行体被拒绝', () => {
    expect(() =>
      validateRecipeRequest('suite/queue-order-flake', { REPLAY_MODE: 'replay' }, [
        { step: 0, point: 'evil-point', resource: 'r', selected: 'consumer-B', waiters: [] },
      ]),
    ).toThrow(/不存在调度点/);
    expect(() =>
      validateRecipeRequest('suite/queue-order-flake', { REPLAY_MODE: 'replay' }, [
        { step: 0, point: 'queue', resource: 'r', selected: 'root-shell', waiters: ['root-shell'] },
      ]),
    ).toThrow(/不允许执行体/);
  });

  it('假执行器目录里不包含任何命令执行入口（静态保证：FAKE_TESTS 是固定枚举）', () => {
    expect(Object.keys(FAKE_TESTS).sort()).toEqual([
      'suite/env-gated-flake',
      'suite/queue-order-flake',
      'suite/timeout-flake',
    ]);
  });
});
