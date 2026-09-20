import { useState } from "react";
import type { TestRun } from "../../core/types";
import { api, type CompareResponse } from "../api";

interface Props {
  runs: TestRun[];
  selected: [string?, string?];
  onSelect: (id: string, slot: 0 | 1) => void;
}

const failing = (runs: TestRun[]) =>
  runs.filter((run) => run.exitStatus !== "passed");

export function CompareView({ runs, selected, onSelect }: Props) {
  const [result, setResult] = useState<CompareResponse | null>(null);
  const [busy, setBusy] = useState(false);

  async function compare() {
    if (!selected[0] || !selected[1]) return;
    setBusy(true);
    try {
      setResult(await api.compare(selected[0], selected[1]));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>比较两条失败</h2>
      <div className="grid two">
        {[0, 1].map((slot) => (
          <label key={slot}>
            {slot === 0 ? "运行 A" : "运行 B"}
            <select
              value={selected[slot] ?? ""}
              onChange={(event) => onSelect(event.target.value, slot as 0 | 1)}
            >
              <option value="">— 选择失败运行 —</option>
              {failing(runs).map((run) => (
                <option key={run.id} value={run.id}>
                  {run.id} · {run.testName}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="row">
        <button
          type="button"
          disabled={!selected[0] || !selected[1] || busy}
          onClick={compare}
          className="primary"
        >
          {busy ? "比较中…" : "比较签名差异"}
        </button>
      </div>

      {result && (
        <div className="compare-result">
          <div className="grid two">
            <SignaturePanel title="A" which={result.a} />
            <SignaturePanel title="B" which={result.b} />
          </div>
          <h4>归一化摘要差异（红删 / 绿增）</h4>
          <pre className="diff">
            {result.tokens.map((token, index) => (
              <span key={index} className={`diff-${token.kind}`}>
                {token.value}
              </span>
            ))}
          </pre>
          <p className="hint">
            {result.a.signature === result.b.signature
              ? "签名相同：归一化后视为同一失败聚类。"
              : "签名不同：行号、错误类型或断言值存在真实差异，保持不同聚类。"}
          </p>
        </div>
      )}
    </section>
  );
}

function SignaturePanel({
  title,
  which,
}: {
  title: string;
  which: CompareResponse["a"];
}) {
  return (
    <div className="signature-panel">
      <h3>
        {title} · {which.errorType || "(无错误类型)"}
      </h3>
      <pre className="normalized small">{which.normalizedSummary}</pre>
      <div className="run-fingerprint">sig {which.signature.slice(0, 20)}…</div>
    </div>
  );
}
