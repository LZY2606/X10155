import { useRef, useState } from "react";
import type { TestRun } from "../../core/types";
import { api } from "../api";

interface Props {
  runs: TestRun[];
  onImported: () => Promise<void> | void;
  onCompare: (runId: string, slot: 0 | 1) => void;
}

export function ImportView({ runs, onImported, onCompare }: Props) {
  const [text, setText] = useState("");
  const [report, setReport] = useState<{
    imported: number;
    skipped: number;
    errors: string[];
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function doImport(recompute: boolean) {
    try {
      const result = await api.importNdjson(text, recompute);
      setReport(result);
      if (result.imported > 0) {
        setText("");
        await onImported();
      }
    } catch (error) {
      setReport({
        imported: 0,
        skipped: 0,
        errors: [error instanceof Error ? error.message : String(error)],
      });
    }
  }

  return (
    <div className="grid two">
      <section className="card">
        <h2>导入 NDJSON 运行记录</h2>
        <p className="hint">
          每行一条结构化运行记录。记录内嵌 <code>fingerprint</code>；指纹不匹配的行会被拒绝，
          原始运行永不改动。重复指纹会跳过，保证聚类成员顺序稳定。
        </p>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder='{"testName":"...","program":"flaky-timer", ...}'
          rows={12}
        />
        <div className="row">
          <button type="button" onClick={() => doImport(false)}>
            导入并校验指纹
          </button>
          <button type="button" className="ghost" onClick={() => doImport(true)}>
            导入并重算指纹
          </button>
          <label className="file-button">
            选择 .ndjson 文件
            <input
              ref={fileRef}
              type="file"
              accept=".ndjson,.jsonl,application/json"
              hidden
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                setText(await file.text());
              }}
            />
          </label>
          <a className="button ghost" href={api.exportUrl()}>
            导出 NDJSON
          </a>
        </div>
        {report && (
          <div className="report">
            <div>
              新导入 <strong>{report.imported}</strong> 条，重复跳过{" "}
              {report.skipped} 条
            </div>
            {report.errors.length > 0 && (
              <ul className="error-list">
                {report.errors.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="card">
        <h2>已保留的原始运行（{runs.length}）</h2>
        <div className="run-list">
          {runs.map((run) => (
            <div key={run.id} className="run-item">
              <div className="run-head">
                <span className={`status status-${run.exitStatus}`}>
                  {run.exitStatus}
                </span>
                <span className="test-name">{run.testName}</span>
              </div>
              <div className="run-meta">
                {run.id} · {run.program} · seed {run.seed}
              </div>
              <div className="run-fingerprint" title={run.fingerprint}>
                fp {run.fingerprint.slice(0, 16)}…
              </div>
              <div className="row">
                <button
                  type="button"
                  className="mini"
                  onClick={() => onCompare(run.id, 0)}
                >
                  比较位 A
                </button>
                <button
                  type="button"
                  className="mini"
                  onClick={() => onCompare(run.id, 1)}
                >
                  比较位 B
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
