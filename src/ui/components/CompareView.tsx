import { useEffect, useMemo, useState } from 'react';
import { api, type CompareResponse, type StatePayload } from '../api.js';

export function CompareView({
  state,
  initialFingerprint,
  onRecipe,
}: {
  state: StatePayload;
  initialFingerprint: string | null;
  onRecipe: (recipeId: string) => void;
}) {
  const [a, setA] = useState(initialFingerprint ?? state.runs[0]?.fingerprint ?? '');
  const [b, setB] = useState(
    state.runs.find((entry) => entry.fingerprint !== a)?.fingerprint ?? '',
  );
  const [rulesetVersion, setRulesetVersion] = useState(state.rulesetVersion);
  const [result, setResult] = useState<CompareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialFingerprint && initialFingerprint !== a) {
      setA(initialFingerprint);
      const other = state.runs.find((entry) => entry.fingerprint !== initialFingerprint);
      setB(other?.fingerprint ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFingerprint]);

  const compare = async () => {
    if (!a || !b) {
      setError('请选择两条运行');
      return;
    }
    try {
      setResult(await api.compare(a, b, rulesetVersion));
      setError(null);
    } catch (compareError) {
      setError((compareError as Error).message);
    }
  };

  const sameHash = result?.a.signature.hash === result?.b.signature.hash;

  return (
    <div>
      <div className="card">
        <h2>比较两条失败</h2>
        <div className="cluster-grid">
          <label className="small">
            运行 A
            <RunSelect runs={state.runs} value={a} onChange={setA} />
          </label>
          <label className="small">
            运行 B
            <RunSelect runs={state.runs} value={b} onChange={setB} />
          </label>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <select
            style={{ width: 160 }}
            value={rulesetVersion}
            onChange={(event) => setRulesetVersion(Number(event.target.value))}
          >
            <option value={1}>规则集 v1</option>
            <option value={state.rulesetVersion}>规则集 v{state.rulesetVersion}</option>
          </select>
          <button className="primary" onClick={() => void compare()}>比较签名</button>
          {result && (
            <span className={`pill ${sameHash ? 'reproduced' : 'not-reproduced'}`}>
              {sameHash ? '签名相同：同一聚类' : '签名不同：近似但不是同一种失败'}
            </span>
          )}
        </div>
        {error && <div className="flash-error">{error}</div>}
      </div>

      {result && (
        <>
          <div className="cluster-grid">
            <RunDetail title="A" data={result.a} />
            <RunDetail title="B" data={result.b} />
          </div>
          <div className="card">
            <h2>输出差异（stderr）</h2>
            <LineDiff
              left={result.a.run.stderrSummary}
              right={result.b.run.stderrSummary}
            />
            <h2>输出差异（stdout 摘要）</h2>
            <LineDiff
              left={result.a.run.stdoutSummary}
              right={result.b.run.stdoutSummary}
            />
          </div>
          <div className="card">
            <h2>从这两条运行建立配方</h2>
            <div className="row">
              <button
                onClick={async () => {
                  const created = await api.createRecipe(result.a.fingerprint);
                  onRecipe(created.recipe.id);
                }}
              >
                用 A 建立重放配方
              </button>
              <button
                onClick={async () => {
                  const created = await api.createRecipe(result.b.fingerprint);
                  onRecipe(created.recipe.id);
                }}
              >
                用 B 建立重放配方
              </button>
              <span className="muted small">
                非内置假执行器的历史运行不能重放（系统拒绝执行任意命令），但仍可参与聚类与比较。
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function RunSelect({
  runs,
  value,
  onChange,
}: {
  runs: StatePayload['runs'];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {runs.map(({ fingerprint, run }) => (
        <option key={fingerprint} value={fingerprint}>
          {run.testName} · {run.seed} · exit {run.exitStatus} · {fingerprint.slice(0, 18)}…
        </option>
      ))}
    </select>
  );
}

function RunDetail({
  title,
  data,
}: {
  title: string;
  data: CompareResponse['a'];
}) {
  return (
    <div className="card">
      <h2>运行 {title}</h2>
      <table className="kv">
        <tbody>
          <tr><td>测试</td><td>{data.run.testName}</td></tr>
          <tr><td>种子</td><td>{data.run.seed}</td></tr>
          <tr><td>退出状态</td><td>{data.run.exitStatus}</td></tr>
          <tr>
            <td>错误类型:行</td>
            <td>{data.run.error?.type} {data.run.error?.file}:{data.run.error?.line}</td>
          </tr>
          <tr>
            <td>断言值</td>
            <td>
              expected={data.run.error?.assertion?.expected ?? '—'} /
              actual={data.run.error?.assertion?.actual ?? '—'}
            </td>
          </tr>
          <tr><td>签名哈希</td><td>{data.signature.hash}</td></tr>
        </tbody>
      </table>
      <details>
        <summary>签名规范载荷</summary>
        <pre className="codeblock">{prettyJson(data.signature.canonical)}</pre>
      </details>
    </div>
  );
}

function prettyJson(canonical: string): string {
  try {
    return JSON.stringify(JSON.parse(canonical), null, 2);
  } catch {
    return canonical;
  }
}

/** 极简 LCS 行级差异，突出行号 / 断言值的真实变化。 */
function LineDiff({ left, right }: { left: string; right: string }) {
  const rows = useMemo(() => diffLines(left.split('\n'), right.split('\n')), [left, right]);
  return (
    <pre className="codeblock">
      {rows.map((row, index) => (
        <div key={index} className={row.kind === 'same' ? 'diff-same' : row.kind === 'del' ? 'diff-del' : 'diff-ins'}>
          {row.kind === 'same' ? '  ' : row.kind === 'del' ? '- ' : '+ '}
          {row.text}
        </div>
      ))}
    </pre>
  );
}

type DiffRow = { kind: 'same' | 'del' | 'ins'; text: string };

function diffLines(left: string[], right: string[]): DiffRow[] {
  const dp: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      dp[i][j] =
        left[i] === right[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      rows.push({ kind: 'same', text: left[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ kind: 'del', text: left[i] });
      i += 1;
    } else {
      rows.push({ kind: 'ins', text: right[j] });
      j += 1;
    }
  }
  while (i < left.length) {
    rows.push({ kind: 'del', text: left[i] });
    i += 1;
  }
  while (j < right.length) {
    rows.push({ kind: 'ins', text: right[j] });
    j += 1;
  }
  return rows;
}
