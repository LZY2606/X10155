import { describe, expect, it } from 'vitest';
import { buildClusterView } from '../src/core/clustering.js';
import { runFingerprint } from '../src/core/fingerprint.js';
import { signatureForRun } from '../src/core/signature.js';
import { buildSeedRuns } from '../src/server/seed.js';
import type { RunRecord } from '../src/core/types.js';

function seeded(): Array<{ run: RunRecord; fingerprint: string }> {
  const seededRuns = buildSeedRuns();
  return seededRuns.runs.map((run, index) => ({
    run,
    fingerprint: seededRuns.fingerprints[index],
  }));
}

describe('失败签名与聚类', () => {
  it('临时路径 / 耗时 / 挂钟时间不同的同一种失败聚到一起（v1：路径+耗时；v2 额外合并时间戳差异）', () => {
    const entries = seeded();
    const v1 = buildClusterView(entries.map((entry) => entry.run), 1);
    const v2 = buildClusterView(entries.map((entry) => entry.run), 2);

    // 假执行器 queue 失败(capacity=2) + 两条“只有路径/耗时噪声”的历史运行(capacity=2) = 3；
    // capacity=4 的运行是环境配置差异，独立成簇。
    const queueV1 = v1.clusters.find((cluster) =>
      cluster.members.includes(runFingerprint(entries[0].run)),
    )!;
    expect(queueV1.members.length).toBe(3);
    expect(queueV1.testName).toBe('suite/queue-order-flake');

    // v2 不会拆散 v1 已合并的簇，也不会把断言值/行号不同的运行并进来
    const queueV2 = v2.clusters.find((cluster) => cluster.id.endsWith(queueV1.signature.hash))
      ?? v2.clusters.find((cluster) =>
        cluster.members.includes(runFingerprint(entries[0].run)),
      )!;
    expect(queueV2.members.length).toBe(3);
  });

  it('近似但不同：断言实际值变化与行号变化必须各自独立成类', () => {
    const entries = seeded();
    const view = buildClusterView(entries.map((entry) => entry.run), 2);
    const queueClusters = view.clusters.filter(
      (cluster) => cluster.testName === 'suite/queue-order-flake',
    );
    // queue 失败形态：
    //  1) 主簇 beta,beta@42（seed-1 + 两条噪声历史运行）
    //  2) seed-47 默认调度 alpha,alpha（假执行器失败）
    //  3) seed-47 固定 B,B + capacity=4，beta,beta 但环境配置不同
    //  4) 历史运行 actual=alpha,alpha@42（断言值不同）
    //  5) 历史运行 beta,beta@43（行号不同）
    const failingQueueEntries = entries.filter(({ run }) =>
      run.testName === 'suite/queue-order-flake' && run.exitStatus !== 0,
    );
    expect(failingQueueEntries.length).toBe(7); // 3 假执行器失败 + 4 历史失败
    expect(queueClusters).toHaveLength(5);
    const memberRuns = new Set(queueClusters.flatMap((cluster) => cluster.members));
    expect(memberRuns.size).toBe(7);
  });

  it('升级规则版本只产生新视图，不改变旧视图的簇 id 与成员顺序', () => {
    const entries = seeded();
    const v1First = buildClusterView(entries.map((entry) => entry.run), 1);
    const v2 = buildClusterView(entries.map((entry) => entry.run), 2);
    const v1Second = buildClusterView(entries.map((entry) => entry.run), 1);
    expect(JSON.stringify(v1First)).toEqual(JSON.stringify(v1Second));
    for (const cluster of v1First.clusters) {
      expect(cluster.id.startsWith('rules1:')).toBe(true);
    }
    for (const cluster of v2.clusters) {
      expect(cluster.id.startsWith('rules2:')).toBe(true);
    }
  });

  it('通过的运行不进聚类', () => {
    const entries = seeded();
    const view = buildClusterView(entries.map((entry) => entry.run), 2);
    const allMembers = new Set(view.clusters.flatMap((cluster) => cluster.members));
    for (const { run, fingerprint } of entries) {
      if (run.exitStatus === 0) {
        expect(allMembers.has(fingerprint)).toBe(false);
      }
    }
  });

  it('聚类成员顺序等于输入顺序（稳定聚类），打乱导入顺序不改变簇内顺序语义', () => {
    const entries = seeded().filter(({ run }) => run.exitStatus !== 0);
    const viewA = buildClusterView(entries.map((entry) => entry.run), 2);
    const reversed = [...entries].reverse();
    const viewB = buildClusterView(reversed.map((entry) => entry.run), 2);

    const biggestA = [...viewA.clusters].sort((x, y) => y.members.length - x.members.length)[0];
    const biggestB = [...viewB.clusters].find((cluster) => cluster.signature.hash === biggestA.signature.hash)!;
    // 成员始终是同一集合；顺序反映各自的导入顺序
    expect([...biggestA.members].sort()).toEqual([...biggestB.members].sort());
    expect(biggestB.members).toEqual([...biggestA.members].reverse());
  });

  it('签名对持续时间和 startedAt 不敏感，但对错误类型/行号/断言值敏感', () => {
    const run = seeded()[0].run;
    const base = signatureForRun(run, 2);
    const noisy: RunRecord = {
      ...run,
      startedAt: '2030-01-01T00:00:00.000Z',
      durationMs: 99999,
      stdoutSummary: run.stdoutSummary.replace(/took \d+ms/, 'took 999ms'),
    };
    expect(signatureForRun(noisy, 2).hash).toBe(base.hash);

    const differentLine: RunRecord = {
      ...run,
      stderrSummary: run.stderrSummary.replace(':42', ':43'),
      error: run.error ? { ...run.error, line: 43 } : null,
    };
    expect(signatureForRun(differentLine, 2).hash).not.toBe(base.hash);

    const differentType: RunRecord = {
      ...run,
      stderrSummary: run.stderrSummary.replace('AssertionError', 'TypeError'),
      error: run.error ? { ...run.error, type: 'TypeError' } : null,
    };
    expect(signatureForRun(differentType, 2).hash).not.toBe(base.hash);

    const differentValue: RunRecord = {
      ...run,
      error: run.error
        ? { ...run.error, assertion: { ...run.error.assertion!, actual: 'alpha,alpha' } }
        : null,
    };
    expect(signatureForRun(differentValue, 2).hash).not.toBe(base.hash);
  });
});

describe('规则版本升级：新规则只产生新的聚类视图', () => {
  function timestampRun(seed: string, timestamp: string, tmp: string): RunRecord {
    return {
      testName: 'suite/queue-order-flake',
      exitStatus: 1,
      stdoutSummary: [
        'queue capacity=2',
        `scratch: ${tmp}/jobs.json`,
        `started ${timestamp}`,
        '[queue] step=0 selected=consumer-B waiters=consumer-A,consumer-B',
        '[queue] step=1 selected=consumer-B waiters=consumer-A,consumer-B',
        'delivery order: beta,beta',
      ].join('\n'),
      stderrSummary: [
        'AssertionError: queue delivery order mismatch',
        '  expected: alpha,beta',
        '  actual:   beta,beta',
        '  at tests/queue_test.ts:42',
      ].join('\n'),
      seed,
      startedAt: timestamp,
      durationMs: 100,
      tempPathRoots: [tmp],
      envWhitelist: { REPLAY_MODE: 'replay' },
      virtualTimeEvents: [],
      scheduleDecisions: [],
      error: {
        type: 'AssertionError',
        message: 'queue delivery order mismatch',
        file: 'tests/queue_test.ts',
        line: 42,
        assertion: { expected: 'alpha,beta', actual: 'beta,beta', operator: 'deepEqual' },
      },
    };
  }

  it('只差 ISO 挂钟时间戳：v1 分开，v2 合并，且 v1 视图不被改写', () => {
    const runA = timestampRun('ci-a', '2026-09-20T11:02:31.482Z', '/tmp/run-a/sess');
    const runB = timestampRun('ci-b', '2026-09-21T08:44:02.005Z', '/tmp/run-b/sess');

    const v1 = buildClusterView([runA, runB], 1);
    const v1Snapshot = JSON.stringify(v1);
    const v2 = buildClusterView([runA, runB], 2);
    const v1Again = buildClusterView([runA, runB], 1);

    const queueV1 = v1.clusters.filter((cluster) => cluster.testName === 'suite/queue-order-flake');
    expect(queueV1).toHaveLength(2);
    const queueV2 = v2.clusters.filter((cluster) => cluster.testName === 'suite/queue-order-flake');
    expect(queueV2).toHaveLength(1);
    expect(queueV2[0].members).toHaveLength(2);

    // 旧视图逐字节稳定
    expect(JSON.stringify(v1Again)).toBe(v1Snapshot);
    // v2 视图必须能解释命中的新规则
    expect(queueV2[0].ruleUsage['wallclock-iso8601-v2'] ?? 0).toBeGreaterThan(0);
  });
});

