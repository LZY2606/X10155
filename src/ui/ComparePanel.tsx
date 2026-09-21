import { useMemo, useState } from 'react';
import { lineDiff } from './diff';
import { signatureForRun } from '../core/normalize';
import type { AppProps } from './types-ui';

function RunSelect(props: {
  label: string;
  state: AppProps['state'];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <label>
      <span className="muted">{props.label}：</span>{' '}
      <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        <option value="">— 选择失败运行 —</option>
        {props.state.runs
          .filter((run) => run.exitStatus !== 0)
          .map((run) => (
            <option key={run.id} value={run.id}>
              {run.id} · {run.testName}
            </option>
          ))}
      </select>
    </label>
  );
}

export function ComparePanel({ state }: AppProps) {
  const [aId, setAId] = useState(() => localStorage.getItem('compare:a') ?? 'r01');
  const [bId, setBId] = useState(() => localStorage.getItem('compare:b') ?? 'r04');

  const runA = state.runs.find((run) => run.id === aId);
  const runB = state.runs.find((run) => run.id === bId);
  const policy = state.noisePolicy;

  const comparison = useMemo(() => {
    if (!runA || !runB) {
      return null;
    }
    const sigA = signatureForRun(runA, policy);
    const sigB = signatureForRun(runB, policy);
    const diff = lineDiff(
      sigA?.evidence.normalizedText ?? '',
      sigB?.evidence.normalizedText ?? '',
    );
    return {
      sigA,
      sigB,
      same: sigA?.signature === sigB?.signature,
      diff,
    };
  }, [runA, runB, policy]);

  return (
    <div>
      <div className="panel">
        <h2>比较两条失败</h2>
        <div className="grid2">
          <RunSelect label="失败 A" state={state} value={aId} onChange={setAId} />
          <RunSelect label="失败 B" state={state} value={bId} onChange={setBId} />
        </div>
      </div>

      {comparison && (
        <>
          <div className="panel">
            <h2>结论</h2>
            <p>
              {comparison.same ? (
                <span className="badge pass">归一化后签名相同 → 同一聚类</span>
              ) : (
                <span className="badge fail">归一化后签名不同 → 必须分开聚类</span>
              )}
            </p>
            <div className="grid2">
              <pre>{comparison.sigA?.signature}</pre>
              <pre>{comparison.sigB?.signature}</pre>
            </div>
          </div>
          <div className="panel">
            <h2>归一化失败文本逐行差异</h2>
            <pre>
              {comparison.diff.map((line, index) => (
                <div
                  key={index}
                  className={
                    line.type === 'del' ? 'diff-del' : line.type === 'add' ? 'diff-add' : ''
                  }
                >
                  {line.type === 'del' ? '- ' : line.type === 'add' ? '+ ' : '  '}
                  {line.text || ' '}
                </div>
              ))}
            </pre>
            <p className="muted">
              行号（如 runner/race.ts:42 对 :51）、错误类型、断言值的变化直接显示为差异，
              噪声规则不会把它们折叠掉。
            </p>
          </div>
        </>
      )}
    </div>
  );
}
