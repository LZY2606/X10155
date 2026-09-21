import { useMemo, useState } from 'react';
import type { StatePayload } from '../api.js';
import type { Cluster } from '../../core/types.js';

export function ClustersView({
  state,
  onCompare,
  onRecipe,
}: {
  state: StatePayload;
  onCompare: (fingerprint: string) => void;
  onRecipe: (recipeId: string) => void;
}) {
  const versions = state.clusterViews.map((view) => view.rulesetVersion).sort();
  const [version, setVersion] = useState(Math.max(...versions));
  const view = state.clusterViews.find((entry) => entry.rulesetVersion === version);
  const rulesById = useMemo(
    () => new Map(state.rules.map((rule) => [rule.id, rule])),
    [state.rules],
  );

  return (
    <div>
      <div className="card">
        <h2>失败签名聚类视图（规则版本可切换，旧视图永不改写）</h2>
        <div className="row">
          {versions.map((ver) => (
            <button
              key={ver}
              className={ver === version ? 'primary' : ''}
              onClick={() => setVersion(ver)}
            >
              规则集 v{ver}
            </button>
          ))}
          <span className="muted small">
            v2 在 v1 基础上新增 wallclock-iso8601-v2：同一种失败若只差挂钟时间戳，会在 v2 合并，v1 视图保持不变。
          </span>
        </div>
      </div>

      {view?.clusters.map((cluster) => (
        <ClusterCard
          key={cluster.id}
          cluster={cluster}
          state={state}
          ruleDescriptions={rulesById}
          onCompare={onCompare}
          onRecipe={onRecipe}
        />
      ))}
      {view?.clusters.length === 0 && (
        <div className="card muted">还没有失败运行。</div>
      )}
    </div>
  );
}

function ClusterCard({
  cluster,
  state,
  ruleDescriptions,
  onCompare,
  onRecipe,
}: {
  cluster: Cluster;
  state: StatePayload;
  ruleDescriptions: Map<string, { id: string; description: string; introducedIn: number }>;
  onCompare: (fingerprint: string) => void;
  onRecipe: (recipeId: string) => void;
}) {
  const recipeForCluster = state.recipes.find(
    (recipe) =>
      recipe.expectedFailureHash === cluster.signature.hash &&
      cluster.members.includes(recipe.sourceRunFingerprint),
  );

  return (
    <div className="card">
      <div className="row">
        <strong>{cluster.testName}</strong>
        <span className="pill fail">{cluster.members.length} 次失败</span>
        <span className="mono muted small">{cluster.id}</span>
        <span className="grow" />
        <button onClick={() => onCompare(cluster.members[0])}>取首条成员去比较</button>
        {recipeForCluster ? (
          <button onClick={() => onRecipe(recipeForCluster.id)}>打开已有配方</button>
        ) : (
          <button onClick={() => onCompare(cluster.members[0])}>先选运行再建配方</button>
        )}
      </div>

      <h3>聚类用了哪些归一化规则（可解释）</h3>
      <table>
        <tbody>
          {Object.entries(cluster.ruleUsage).map(([ruleId, hits]) => {
            const rule = ruleDescriptions.get(ruleId);
            return (
              <tr key={ruleId}>
                <td className="mono">{ruleId}</td>
                <td>{hits} 处命中</td>
                <td className="muted small">{rule?.description}</td>
              </tr>
            );
          })}
          {Object.keys(cluster.ruleUsage).length === 0 && (
            <tr>
              <td className="muted" colSpan={3}>该签名没有触发任何噪声归一化（失败形态完全一致）。</td>
            </tr>
          )}
        </tbody>
      </table>

      <details>
        <summary>归一化证据样例（保留行号、错误类型、断言值）</summary>
        {cluster.signature.traces.map((trace, index) => (
          <div key={index} className="kv small">
            <span className="pill in-progress">{trace.ruleId}</span>{' '}
            <span className="diff-del">{trace.before}</span> →{' '}
            <span className="diff-ins">{trace.after}</span>{' '}
            <span className="muted">@offset {trace.index}</span>
          </div>
        ))}
      </details>

      <h3>成员（顺序 = 首次导入顺序，稳定）</h3>
      <table>
        <thead>
          <tr><th>#</th><th>运行指纹</th><th>种子</th><th>错误行</th><th>断言 期望 / 实际</th><th></th></tr>
        </thead>
        <tbody>
          {cluster.members.map((fingerprint, index) => {
            const run = state.runs.find((entry) => entry.fingerprint === fingerprint)?.run;
            if (!run) {
              return null;
            }
            return (
              <tr key={fingerprint}>
                <td>{index + 1}</td>
                <td className="mono small">{fingerprint}</td>
                <td className="mono">{run.seed}</td>
                <td className="mono">{run.error?.file}:{run.error?.line}</td>
                <td className="mono small">
                  {run.error?.assertion
                    ? `${run.error.assertion.expected} ≠ ${run.error.assertion.actual}`
                    : '—'}
                </td>
                <td><button onClick={() => onCompare(fingerprint)}>比较 / 建配方</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
