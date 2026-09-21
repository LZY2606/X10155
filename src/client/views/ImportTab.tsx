import { useRef, useState } from "react";
import { api, type Snapshot } from "../api.js";

interface Props {
  snapshot: Snapshot;
  onImported: (snapshot: Snapshot) => void;
}

export function ImportTab({ snapshot, onImported }: Props) {
  const [text, setText] = useState("");
  const [report, setReport] = useState<{
    imported: string[];
    duplicates: number;
    errors: { line: number; error: string }[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const doImport = async () => {
    setBusy(true);
    try {
      const result = await api.importNdjson(text);
      setReport({ imported: result.imported, duplicates: result.duplicates, errors: result.errors });
      onImported(result.state);
    } finally {
      setBusy(false);
    }
  };

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    setText(await file.text());
  };

  return (
    <div className="grid-two">
      <section className="card">
        <h2>导入 NDJSON 运行记录</h2>
        <p className="hint">
          每行一条结构化运行（测试名、退出状态、输出摘要、种子、环境白名单、虚拟时间、调度轨迹）。
          原始运行永远保留；缺省指纹按内容计算，指纹与内容不符的行会被拒绝。
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".ndjson,.jsonl,application/x-ndjson"
          onChange={(event) => void loadFile(event.target.files?.[0])}
        />
        <textarea
          rows={14}
          placeholder='{"testName":"suite/x","status":"fail","exitCode":1,"stdoutSummary":"...","seed":7,"env":{},"schedule":[],"virtualTime":[]}'
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="row">
          <button type="button" disabled={busy || !text.trim()} onClick={() => void doImport()}>
            {busy ? "导入中…" : "导入"}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              const sample = snapshot.runs[0];
              if (sample) setText(JSON.stringify(sample));
            }}
          >
            填入一条当前数据做模板
          </button>
        </div>
        {report && (
          <div className="banner">
            导入 {report.imported.length} 条，跳过重复 {report.duplicates} 条，坏行{" "}
            {report.errors.length} 条。
            {report.errors.map((err) => (
              <div key={err.line} className="error-line">
                第 {err.line} 行：{err.error}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h2>导出</h2>
        <p className="hint">导出保持运行指纹与聚类成员的导入顺序。</p>
        <a className="button-link" href="/api/export">
          下载 runs.ndjson
        </a>
        <h3>已保留的原始运行</h3>
        <table className="data">
          <thead>
            <tr>
              <th>#</th>
              <th>测试</th>
              <th>状态</th>
              <th>种子</th>
              <th>指纹</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.runs.map((run) => (
              <tr key={run.fingerprint}>
                <td>{run.importSeq}</td>
                <td>{run.testName}</td>
                <td className={`status-${run.status}`}>{run.status}</td>
                <td>{run.seed ?? "—"}</td>
                <td className="mono small">{run.fingerprint.slice(0, 22)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
