import { useMemo, useState } from "react";
import { api, type Snapshot } from "../api.js";
import type { ClusterView, RuleVersion } from "../../core/types.js";

interface Props {
  snapshot: Snapshot;
  onSelectRun: (fingerprint: string) => void;
  onCreateRecipe: () => void;
}

export function ClusterTab({ snapshot, onSelectRun }: Props) {
  const [version, setVersion] = useState<RuleVersion>("rules-v1");
  const [open, setOpen] = useState<string | null>(null);
  const [busyFingerprint, setBusyFingerprint] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const clusters = useMemo(
    () => snapshot.clusters.filter((cluster) => cluster.ruleVersion === version),
    [snapshot.clusters, version],
  );

  const createRecipe = async (fingerprint: string) => {
    setBusyFingerprint(fingerprint);
    setMessage(null);
    try {
      await api.createRecipe(fingerprint);
      setMessage("已从该运行建立重放配方，请到“重放配方”页查看。");
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusyFingerprint(null);
    }
  };

  const runByFp = useMemo(
    () => new Map(snapshot.runs.map((run) => [run.fingerprint, run])),
    [snapshot.runs],
  );

  return (
    <div>
      <div className="row version-row">
        <strong>归一化规则版本：</strong>
        {snapshot.ruleVersions.map((ruleVersion) => (
          <button
            key={ruleVersion}
            type="button"
            className={ruleVersion === version ? "active" : ""}
            onClick={() => {
              setVersion(ruleVersion);
              setOpen(null);
            }}
          >
            {ruleVersion}
          </button>
        ))}
        <span className="hint">
          {version === "rules-v1"
            ? "声明临时路径 + 带单位持续时间"
            : "v1 + 进程/线程标识 + 十六进制地址；只生成新视图，不改写 v1"}
        </span>
      </div>

      {message && <div className="banner">{message}</div>}

      <div className="cluster-list">
        {clusters.length === 0 && <p className="hint">当前规则版本下没有失败运行。</p>}
        {clusters.map((cluster) => (
          <ClusterCard
            key={cluster.signatureHash}
            cluster={cluster}
            expanded={open === cluster.signatureHash}
            onToggle={() => setOpen(open === cluster.signatureHash ? null : cluster.signatureHash)}
            runByFp={runByFp}
            onSelectRun={onSelectRun}
            busyFingerprint={busyFingerprint}
            onCreateRecipe={(fingerprint) => void createRecipe(fingerprint)}
          />
        ))}
      </div>
    </div>
  );
}

function ClusterCard({
  cluster,
  expanded,
  onToggle,
  runByFp,
  onSelectRun,
  busyFingerprint,
  onCreateRecipe,
}: {
  cluster: ClusterView;
  expanded: boolean;
  onToggle: () => void;
  runByFp: Map<string, Snapshot["runs"][number]>;
  onSelectRun: (fingerprint: string) => void;
  busyFingerprint: string | null;
  onCreateRecipe: (fingerprint: string) => void;
}) {
  return (
    <section className="card cluster">
      <button type="button" className="cluster-head" onClick={onToggle}>
        <span className="badge">{cluster.members.length} 次</span>
        <span className="testname">{cluster.testName}</span>
        <span className={`status-pill status-${cluster.status}`}>{cluster.status}</span>
        <span className="mono small">{cluster.signatureHash.slice(0, 18)}…</span>
        <span className="twisty">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="cluster-body">
          <h4>归一化后的签名（行号 / 错误类型 / 断言值保持原样）</h4>
          <pre className="summary">{cluster.normalizedSummary}</pre>
          <h4>这个聚类用了哪些归一化规则</h4>
          {cluster.normalization.transforms.length === 0 ? (
            <p className="hint">该签名未命中任何噪声规则。</p>
          ) : (
            <ul className="rule-evidence">
              {cluster.normalization.transforms.map((transform) => (
                <li key={transform.ruleId}>
                  <code>{transform.ruleId}</code>：{transform.description}
                  <div>
                    命中 {transform.matches.length} 处 → 替换为 <code>{transform.replacement}</code>
                  </div>
                  <div className="mono small muted">
                    {transform.matches.slice(0, 4).map((match) => JSON.stringify(match)).join("  ")}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <h4>成员（按导入顺序）</h4>
          <table className="data">
            <thead>
              <tr>
                <th>#</th>
                <th>指纹</th>
                <th>种子</th>
                <th>耗时</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {cluster.members.map((member) => {
                const run = runByFp.get(member.fingerprint);
                return (
                  <tr key={member.fingerprint}>
                    <td>{member.importSeq}</td>
                    <td className="mono small">{member.fingerprint.slice(0, 18)}…</td>
                    <td>{run?.seed ?? "—"}</td>
                    <td>{run?.durationMs ?? "—"} ms</td>
                    <td>
                      <button type="button" className="ghost" onClick={() => onSelectRun(member.fingerprint)}>
                        查看
                      </button>
                      <button
                        type="button"
                        disabled={busyFingerprint === member.fingerprint}
                        onClick={() => onCreateRecipe(member.fingerprint)}
                      >
                        {busyFingerprint === member.fingerprint ? "建立中…" : "建立重放配方"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
