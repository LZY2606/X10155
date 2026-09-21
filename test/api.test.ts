import { describe, expect, it } from 'vitest';
import { createApiHandler } from '../src/server/api.js';
import { Store } from '../src/core/store.js';
import { exportNdjson, parseNdjson } from '../src/core/io.js';
import { executeFakeTest } from '../src/core/fakeExecutor.js';
import { runFingerprint } from '../src/core/fingerprint.js';
import { buildRecipeFromRun } from '../src/core/recipe.js';

function harness(store = new Store()) {
  const handle = createApiHandler(store);
  return {
    store,
    call: (method: string, path: string, body?: unknown) => handle({ method, path, body }),
  };
}

function queueRun(overrides: { seed: string; actual?: string; line?: number; tmp?: string; startedAt?: string }) {
  const { run } = executeFakeTest('suite/queue-order-flake', overrides.seed, { REPLAY_MODE: 'replay' }, [
    { step: 0, point: 'queue', resource: 'job-queue', selected: 'consumer-B', waiters: ['consumer-A', 'consumer-B'] },
    { step: 1, point: 'queue', resource: 'job-queue', selected: 'consumer-B', waiters: ['consumer-A', 'consumer-B'] },
  ]);
  if (run.exitStatus === 0) {
    throw new Error('fixture seed did not fail');
  }
  return {
    ...run,
    startedAt: overrides.startedAt ?? run.startedAt,
    stderrSummary: run.stderrSummary.replace(':42', `:${overrides.line ?? 42}`),
    error: run.error ? { ...run.error, line: overrides.line ?? run.error.line } : null,
  } as typeof run;
}

describe('NDJSON 导入与指纹', () => {
  it('非法行整批拒绝并报告行号', () => {
    const valid = queueRun({ seed: 'seed-1' });
    const parsed = parseNdjson(`${JSON.stringify(valid)}\nnot-json\n`);
    // 解析器标出所有合法行与非法行；服务端在 issues 非空时整批拒绝。
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.issues[0].line).toBe(2);
    const rejected = harness().call('POST', '/api/import', {
      text: `${JSON.stringify(valid)}\nnot-json\n`,
    });
    expect(rejected.status).toBe(400);
    expect((rejected.body as { issues: unknown[] }).issues).toHaveLength(1);
  });

  it('API 导入：内容指纹幂等，成员顺序按导入顺序', () => {
    const { call, store } = harness();
    const run1 = queueRun({ seed: 'seed-1' });
    const run2 = queueRun({ seed: 'seed-3', tmp: 'ignored' });
    const text = [run1, run2, run1].map((run) => JSON.stringify(run)).join('\n');
    const response = call('POST', '/api/import', { text });
    expect(response.status).toBe(200);
    const { imported } = response.body as { imported: string[] };
    expect(imported).toHaveLength(2); // 第三条重复，跳过

    const state = call('GET', '/api/state').body as {
      clusterViews: Array<{ rulesetVersion: number; clusters: Array<{ members: string[] }> }>;
    };
    const v2 = state.clusterViews.find((view) => view.rulesetVersion === 2)!;
    const cluster = v2.clusters.find((entry) => entry.members.includes(imported[0]))!;
    expect(cluster.members).toEqual(imported);
    expect(store.state.runOrder).toEqual(imported);
  });

  it('导出再导入：携带 fingerprint 且顺序/指纹稳定；指纹被篡改则拒绝', () => {
    const { call } = harness();
    const run1 = queueRun({ seed: 'seed-1' });
    const run2 = queueRun({ seed: 'seed-3' });
    call('POST', '/api/import', { text: [run1, run2].map((entry) => JSON.stringify(entry)).join('\n') });

    const exported = call('GET', '/api/export').body as string;
    const lines = exported.trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { fingerprint: string };
      expect(parsed.fingerprint.startsWith('run_')).toBe(true);
    }

    // 原样再导入到一个空仓库：全部识别为重复内容不会报错（这里导入新空仓 => 接受）
    const fresh = harness();
    const roundTrip = fresh.call('POST', '/api/import', { text: exported });
    expect(roundTrip.status).toBe(200);
    expect(fresh.store.state.runOrder).toEqual(
      lines.map((line) => (JSON.parse(line) as { fingerprint: string }).fingerprint),
    );

    // 篡改 fingerprint 字段 => 拒绝
    const tampered = exported.replace(/run_[0-9a-f]{16}/, 'run_0000000000000000');
    const rejected = harness().call('POST', '/api/import', { text: tampered });
    expect(rejected.status).toBe(400);
  });
});

describe('API 安全边界', () => {
  it('为非内置测试建配方返回 400；越出执行器的配方编辑返回 422', () => {
    const { call, store } = harness();
    const foreign = queueRun({ seed: 'seed-1' });
    const foreignRun = { ...foreign, testName: 'project/real-test' };
    store.importRuns([foreignRun]);
    const fingerprint = runFingerprint(foreignRun);
    const response = call('POST', '/api/recipes', { fingerprint });
    expect(response.status).toBe(400);
  });

  it('路径逃逸与越权环境键在编辑接口被 422 拒绝', () => {
    const { call } = harness();
    const { run } = executeFakeTest(
      'suite/env-gated-flake',
      'seed-1',
      { REPLAY_MODE: 'replay', FLAKY_FEATURE_TOGGLE: 'on' },
    );
    const fingerprint = runFingerprint(run);
    call('POST', '/api/import', { text: JSON.stringify(run) });
    const created = call('POST', '/api/recipes', { fingerprint });
    const recipeId = (created.body as { recipe: { id: string } }).recipe.id;

    const escape = call('PUT', `/api/recipes/${recipeId}`, {
      seed: 'seed-1',
      env: { REPLAY_MODE: 'replay', FLAKY_TMPDIR: '/etc/passwd' },
      schedule: [],
    });
    expect(escape.status).toBe(422);
    expect(String((escape.body as { error: string }).error)).toMatch(/越出|沙箱/);

    const extraKey = call('PUT', `/api/recipes/${recipeId}`, {
      seed: 'seed-1',
      env: { REPLAY_MODE: 'replay', EVIL: 'x' },
      schedule: [],
    });
    expect(extraKey.status).toBe(422);

    const shell = call('PUT', `/api/recipes/${recipeId}`, {
      seed: 'seed-1',
      env: { REPLAY_MODE: 'replay; whoami' },
      schedule: [],
    });
    expect(shell.status).toBe(422);
  });

  it('未知测试 id 无法通过任何途径进入重放（配方只能来自内置测试）', () => {
    const { store } = harness();
    const bad: Parameters<Store['importRuns']>[0][number] = {
      testName: 'suite/timeout-flake',
      exitStatus: 2,
      stdoutSummary: '',
      stderrSummary: '',
      seed: 'x',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 0,
      tempPathRoots: [],
      envWhitelist: { REPLAY_MODE: 'replay' },
      virtualTimeEvents: [],
      scheduleDecisions: [],
      error: null,
    };
    store.importRuns([bad]);
    const fp = runFingerprint(bad);
    // 绕过 Store 构造一个“被手工篡改成外部命令名”的状态（指纹键保持不变）：
    // 处理器依然只能依据内置假执行器目录判断，并且必须拒绝。
    const state = store.toJSON();
    state.runs[fp].testName = 'totally/external-command';
    const poisoned = new Store(state);
    const handler = createApiHandler(poisoned);
    expect(handler({ method: 'POST', path: '/api/recipes', body: { fingerprint: fp } }).status).toBe(400);
  });
});

describe('API 重放与最小化', () => {
  function setup() {
    const h = harness();
    const { run } = executeFakeTest('suite/timeout-flake', 'seed-1', { REPLAY_MODE: 'replay' });
    const fingerprint = runFingerprint(run);
    h.call('POST', '/api/import', { text: JSON.stringify(run) });
    const created = h.call('POST', '/api/recipes', { fingerprint });
    const recipe = (created.body as { recipe: ReturnType<typeof buildRecipeFromRun> }).recipe;
    return { ...h, recipe, fingerprint };
  }

  it('重放返回三态之一，复现/不兼容判定正确', () => {
    const { call, recipe } = setup();
    const replay = call('POST', `/api/recipes/${recipe.id}/replay`);
    expect(replay.status).toBe(200);
    expect((replay.body as { outcome: { verdict: string } }).outcome.verdict).toBe('reproduced');
  });

  it('逐步最小化 API：小预算下 budget-exhausted，返回当前最小结果', () => {
    const { call, recipe } = setup();
    const response = call('POST', `/api/recipes/${recipe.id}/minimize`, { budget: 2, steps: 5 });
    expect(response.status).toBe(200);
    const minimization = (response.body as { minimization: { status: string; replaysUsed: number } }).minimization;
    expect(minimization.status).toBe('budget-exhausted');
    expect(minimization.replaysUsed).toBe(2);
  });

  it('继续最小化沿用同一实验与已用预算；证据全部保留', () => {
    const h = harness();
    const { run } = executeFakeTest('suite/queue-order-flake', 'seed-1', { REPLAY_MODE: 'replay' }, [
      { step: 0, point: 'queue', resource: 'job-queue', selected: 'consumer-B', waiters: ['consumer-A', 'consumer-B'] },
      { step: 1, point: 'queue', resource: 'job-queue', selected: 'consumer-B', waiters: ['consumer-A', 'consumer-B'] },
    ]);
    const fingerprint = runFingerprint(run);
    h.call('POST', '/api/import', { text: JSON.stringify(run) });
    const created = h.call('POST', '/api/recipes', { fingerprint });
    const recipe = (created.body as { recipe: { id: string } }).recipe;

    const first = h.call('POST', `/api/recipes/${recipe.id}/minimize`, { budget: 8, steps: 2 });
    const firstMin = (first.body as {
      minimization: { id: string; steps: unknown[]; replaysUsed: number; status: string };
    }).minimization;
    expect(firstMin.steps.length).toBe(3); // 基线 + 2 尝试
    expect(firstMin.replaysUsed).toBe(3);

    const second = h.call('POST', `/api/recipes/${recipe.id}/minimize`, {
      budget: 8,
      continueId: firstMin.id,
      steps: 4,
    });
    const secondMin = (second.body as {
      minimization: { id: string; steps: unknown[]; replaysUsed: number; status: string };
    }).minimization;
    expect(secondMin.id).toBe(firstMin.id);
    // 第一次（steps=2）已经把所有候选试完到达固定点时，继续调用是幂等的；
    // 否则第二次会继续消耗预算并增加证据。
    if (firstMin.status === 'in-progress') {
      expect(secondMin.replaysUsed).toBeGreaterThan(firstMin.replaysUsed);
      expect(secondMin.steps.length).toBeGreaterThan(firstMin.steps.length);
    } else {
      expect(secondMin.replaysUsed).toBe(firstMin.replaysUsed);
    }
    expect(['fixed-point', 'budget-exhausted']).toContain(secondMin.status);
    // 证据链完整：基线 + 每个尝试一步，且步数与重放次数一致
    expect(secondMin.steps.length).toBe(secondMin.replaysUsed);
  });
});

describe('导出工具保持指纹与顺序', () => {
  it('exportNdjson 输出顺序与输入完全一致', () => {
    const r1 = queueRun({ seed: 'seed-1' });
    const r2 = queueRun({ seed: 'seed-3' });
    const fp1 = runFingerprint(r1);
    const fp2 = runFingerprint(r2);
    const ndjson = exportNdjson([r2, r1], [fp2, fp1]);
    const parsed = ndjson.trim().split('\n').map((line) => JSON.parse(line) as { fingerprint: string });
    expect(parsed.map((entry) => entry.fingerprint)).toEqual([fp2, fp1]);
  });
});
