import { Fragment, useState } from 'react';
import { api, type StatePayload } from '../api.js';

export function RunsView({
  state,
  onCompare,
  onRecipe,
}: {
  state: StatePayload;
  onCompare: (fingerprint: string) => void;
  onRecipe: (recipeId: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createRecipe = async (fingerprint: string) => {
    setError(null);
    try {
      const result = await api.createRecipe(fingerprint);
      onRecipe(result.recipe.id);
    } catch (createError) {
      setError((createError as Error).message);
    }
  };

  return (
    <div className="card">
      <h2>原始运行（不可变，指纹 = 内容哈希）</h2>
      {error && <div className="flash-error">{error}</div>}
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>测试</th>
            <th>状态</th>
            <th>种子</th>
            <th>指纹</th>
            <th>临时路径声明</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {state.runs.map(({ fingerprint, run }, index) => (
            <Fragment key={fingerprint}>
              <tr key={fingerprint}>
                <td>{index + 1}</td>
                <td>{run.testName}</td>
                <td>
                  <span className={`pill ${run.exitStatus === 0 ? 'pass' : 'fail'}`}>
                    exit {run.exitStatus}
                  </span>
                </td>
                <td className="mono">{run.seed}</td>
                <td className="mono small">{fingerprint}</td>
                <td className="small muted">{run.tempPathRoots?.join(' | ') || '—'}</td>
                <td>
                  <button onClick={() => onCompare(fingerprint)}>比较</button>{' '}
                  <button onClick={() => void createRecipe(fingerprint)}>建配方</button>{' '}
                  <button onClick={() => setOpen(open === fingerprint ? null : fingerprint)}>
                    {open === fingerprint ? '收起' : '详情'}
                  </button>
                </td>
              </tr>
              {open === fingerprint && (
                <tr key={`${fingerprint}-detail`}>
                  <td colSpan={7}>
                    <pre className="codeblock">{JSON.stringify(run, null, 2)}</pre>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
