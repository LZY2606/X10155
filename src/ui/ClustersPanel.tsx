import { useMemo, useState } from 'react';
import { api } from './api';
import { PACK_VERSIONS, type AppProps } from './types-ui';

export function ClustersPanel({ state, refresh, notify }: AppProps) {
  const [packVersion, setPackVersion] = useState<number>(state.activePackVersion);
  const [tempRootsText, setTempRootsText] = useState(
    state.noisePolicy.tempRoots.join('\n'),
  );

  const view = useMemo(
    () =>
      state.clusterViews.find(
        (entry) =>
          entry.packId === 'builtin' && entry.packVersion === packVersion,
      ),
    [state.clusterViews, packVersion],
  );

  async function chooseVersion(version: number) {
    setPackVersion(version);
    await api.setPolicy({ packVersion: version });
    notify(`已切换到规则包 builtin@v${version}：仅改变当前聚类视图，历史视图保留`);
    await refresh();
  }

  async function saveRoots() {
    const roots = tempRootsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    try {
      const { policy } = await api.setPolicy({ tempRoots: roots });
      notify(`临时路径噪声声明已更新（策略版本 p${policy.policyVersion}）`);
      await refresh();
    } catch (error) {
      notify((error as Error).message, true);
    }
  }

  function selectForCompare(runId: string, slot: 'a' | 'b') {
    localStorage.setItem(`compare:${slot}`, runId);
    notify(`已把 ${runId} 放入比较槽 ${slot.toUpperCase()}，切到“比较失败”页查看`);
  }

  return (
    <div>
      <div className="panel">
        <h2>噪声策略与规则版本</h2>
        <div className="grid2">
          <div>
            <h3>规则包版本（新规则只生成新视图）</h3>
            <div className="row">
              {PACK_VERSIONS.map((version) => (
                <button
                  key={version}
                  className={packVersion === version ? 'primary' : ''}
                  onClick={() => chooseVersion(version)}
                >
                  builtin@v{version}
                </button>
              ))}
            </div>
            <p className="muted" style={{ marginTop: 8 }}>
              当前：{view?.viewKey}。行号、错误类型、断言值不参与任何归一化，
              其变化必然拆开聚类；只有带单位的耗时、0x 地址、v2 的 ISO 时间戳与显式线程号被归一化。
            </p>
          </div>
          <div>
            <h3>用户声明的临时路径噪声（每行一个根）</h3>
            <textarea
              style={{ minHeight: 90 }}
              value={tempRootsText}
              onChange={(event) => setTempRootsText(event.target.value)}
            />
            <button onClick={saveRoots}>保存临时路径声明</button>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>
          聚类视图 <span className="muted">{view?.clusters.length ?? 0} 个失败签名</span>
        </h2>
        {view?.clusters.map((cluster) => {
          const run = state.runs.find((entry) => entry.id === cluster.representativeRunId);
          return (
            <div className="cluster-card" key={cluster.clusterId}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <b>{run?.testName ?? cluster.representativeRunId}</b>
                  <div className="fingerprint">签名 {cluster.signature}</div>
                </div>
                <div className="muted">{cluster.memberRunIds.length} 条成员</div>
              </div>
              <div style={{ margin: '8px 0' }}>
                {cluster.memberRunIds.map((runId) => (
                  <span className="member-chip" key={runId}>
                    {runId}
                  </span>
                ))}
              </div>
              <details>
                <summary>查看归一化证据（用了哪些规则）</summary>
                <div className="kv" style={{ marginTop: 8 }}>
                  规则包 <b>{cluster.packId}@v{cluster.packVersion}</b> · 策略版本{' '}
                  <b>p{cluster.policyVersion}</b>
                </div>
                <div style={{ marginTop: 8 }}>
                  <div className="muted">原始失败文本：</div>
                  <pre>{cluster.evidence.rawFailureText}</pre>
                  <div className="muted">归一化后（参与签名）：</div>
                  <pre>{cluster.evidence.normalizedText}</pre>
                  <div>
                    {cluster.evidence.tempHits.length === 0 &&
                    cluster.evidence.ruleHits.length === 0 ? (
                      <span className="muted">无替换发生</span>
                    ) : null}
                    {cluster.evidence.tempHits.map((hit, index) => (
                      <div className="temp-hit" key={`tmp-${index}`}>
                        临时路径规则：{hit.matched} → &lt;TMP&gt;（根 {hit.root}，位置 {hit.index}）
                      </div>
                    ))}
                    {cluster.evidence.ruleHits.map((hit, index) => (
                      <div className="rule-hit" key={`rule-${index}`}>
                        规则 {hit.ruleId}：{hit.matched} → {hit.replacement}（位置 {hit.index}）
                      </div>
                    ))}
                  </div>
                </div>
              </details>
              <div className="row" style={{ marginTop: 8 }}>
                <button onClick={() => selectForCompare(cluster.representativeRunId, 'a')}>
                  代表 → 比较 A
                </button>
                <button onClick={() => selectForCompare(cluster.memberRunIds[0]!, 'b')}>
                  首成员 → 比较 B
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
