import { useState } from "react";
import type { Cluster, RuleVersion, TestRun } from "../../core/types";

interface Props {
  clusters: Cluster[];
  runsById: Map<string, TestRun>;
  version: RuleVersion;
  onSelectRun: (runId: string) => void;
  onReplay: (runId: string) => Promise<void>;
}

export function ClusterView({
  clusters,
  runsById,
  version,
  onSelectRun,
  onReplay,
}: Props) {
  const [openId, setOpenId] = useState<string | null>(clusters[0]?.id ?? null);
  const failingCount = clusters.reduce((sum, c) => sum + c.memberIds.length, 0);

  return (
    <section className="card">
      <h2>
        失败签名聚类
        <span className="badge">
          规则 {version} · {clusters.length} 个聚类 · {failingCount} 条失败
        </span>
      </h2>
      <p className="hint">
        签名折叠声明的临时路径与耗时噪声，但保留文件行号、错误类型与断言值。
        切换到新规则版本只会生成新的聚类视图，旧视图不被改写。
      </p>
      <div className="cluster-list">
        {clusters.map((cluster) => {
          const open = openId === cluster.id;
          return (
            <div key={cluster.id} className="cluster">
              <button
                type="button"
                className="cluster-head"
                onClick={() => setOpenId(open ? null : cluster.id)}
              >
                <span className="cluster-count">{cluster.memberIds.length}</span>
                <span className="cluster-title">
                  {cluster.testName}
                  <small>
                    {cluster.errorType} · {cluster.id}
                  </small>
                </span>
                <span className="chev">{open ? "▾" : "▸"}</span>
              </button>
              {open && (
                <div className="cluster-body">
                  <pre className="normalized">{cluster.normalizedSummary}</pre>
                  <h4>使用的归一化规则（可解释）</h4>
                  <ul className="rule-list">
                    {cluster.ruleExplanations.map((rule) => (
                      <li key={rule.id} className={rule.hits ? "hit" : "idle"}>
                        <code>
                          {rule.id}@{rule.version}
                        </code>{" "}
                        ×{rule.hits} — {rule.description}
                      </li>
                    ))}
                  </ul>
                  <h4>成员（导入顺序）</h4>
                  <ol className="member-list">
                    {cluster.memberIds.map((id) => {
                      const run = runsById.get(id);
                      if (!run) return <li key={id}>{id}（已缺失）</li>;
                      return (
                        <li key={id}>
                          <div>
                            <code>{id}</code> · seed {run.seed}
                            <pre className="raw-summary">{run.stdoutSummary}</pre>
                          </div>
                          <div className="row">
                            <button
                              type="button"
                              className="mini"
                              onClick={() => onSelectRun(id)}
                            >
                              比较
                            </button>
                            <button
                              type="button"
                              className="mini primary"
                              onClick={() => onReplay(id)}
                            >
                              建立重放配方
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
