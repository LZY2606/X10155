import { useEffect, useMemo, useState } from 'react';
import { api, type StatePayload } from '../api.js';
import type { ReplayOutcome, ReplayRecipe } from '../../core/types.js';

export function RecipeView({
  state,
  initialRecipeId,
  onChanged,
  onMinimize,
}: {
  state: StatePayload;
  initialRecipeId: string | null;
  onChanged: () => Promise<void>;
  onMinimize: (recipeId: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(
    initialRecipeId ?? state.recipes[0]?.id ?? '',
  );
  const recipe = state.recipes.find((entry) => entry.id === selectedId) ?? null;

  useEffect(() => {
    if (initialRecipeId && initialRecipeId !== selectedId) {
      setSelectedId(initialRecipeId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRecipeId]);

  return (
    <div>
      <div className="card">
        <h2>重放配方</h2>
        {state.recipes.length === 0 ? (
          <p className="muted">还没有配方。去“比较两条失败”或“原始运行”里从一条运行建立。</p>
        ) : (
          <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
            {state.recipes.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.fakeTest} · seed={entry.seed} · {entry.id.slice(0, 22)}…
              </option>
            ))}
          </select>
        )}
      </div>
      {recipe && (
        <RecipeEditor
          key={recipe.id}
          recipe={recipe}
          state={state}
          onChanged={onChanged}
          onCreated={(id) => setSelectedId(id)}
          onMinimize={onMinimize}
        />
      )}
    </div>
  );
}

function RecipeEditor({
  recipe,
  state,
  onChanged,
  onCreated,
  onMinimize,
}: {
  recipe: ReplayRecipe;
  state: StatePayload;
  onChanged: () => Promise<void>;
  onCreated: (id: string) => void;
  onMinimize: (id: string) => void;
}) {
  const fakeTest = state.fakeTests.find((entry) => entry.id === recipe.fakeTest);
  const [seed, setSeed] = useState(recipe.seed);
  const [envText, setEnvText] = useState(JSON.stringify(recipe.env, null, 2));
  const [scheduleText, setScheduleText] = useState(JSON.stringify(recipe.schedule, null, 2));
  const [outcome, setOutcome] = useState<ReplayOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const envParsed = useMemo<Record<string, string> | null>(() => {
    try {
      const value = JSON.parse(envText) as unknown;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
      }
      for (const envValue of Object.values(value as Record<string, unknown>)) {
        if (typeof envValue !== 'string') {
          return null;
        }
      }
      return value as Record<string, string>;
    } catch {
      return null;
    }
  }, [envText]);

  const scheduleParsed = useMemo(() => {
    try {
      const value = JSON.parse(scheduleText) as unknown;
      if (!Array.isArray(value)) {
        return null;
      }
      return value;
    } catch {
      return null;
    }
  }, [scheduleText]);

  const save = async () => {
    setError(null);
    if (!envParsed || !scheduleParsed) {
      setError('env 必须是字符串对象的 JSON；schedule 必须是数组的 JSON。');
      return;
    }
    try {
      const result = await api.updateRecipe(recipe.id, {
        seed,
        env: envParsed,
        schedule: scheduleParsed as ReplayRecipe['schedule'],
      });
      setNotice('配方已保存（内容变化会生成新的内容寻址 id，旧配方保留）。');
      await onChanged();
      onCreated(result.recipe.id);
    } catch (saveError) {
      setError((saveError as Error).message);
    }
  };

  const replay = async () => {
    setError(null);
    setNotice(null);
    try {
      setOutcome((await api.replay(recipe.id)).outcome);
    } catch (replayError) {
      setError((replayError as Error).message);
    }
  };

  return (
    <>
      <div className="card">
        <h2>{recipe.fakeTest}</h2>
        <table className="kv">
          <tbody>
            <tr><td>配方 id</td><td>{recipe.id}</td></tr>
            <tr><td>来源运行</td><td>{recipe.sourceRunFingerprint}</td></tr>
            <tr>
              <td>期望</td>
              <td>
                exit={recipe.expectedExitStatus}，失败签名 {recipe.expectedFailureHash ?? '（期望通过）'}
                （规则集 v{recipe.rulesetVersion}）
              </td>
            </tr>
            {fakeTest && (
              <tr>
                <td>执行器边界</td>
                <td className="small muted">
                  允许的环境键：{fakeTest.allowedEnvKeys.join(', ')}；
                  路径类键：{fakeTest.pathEnvKeys.join(', ') || '无'}；
                  调度点：{Object.entries(fakeTest.schedulePoints).map(
                    ([point, actors]) => `${point}(${actors.join('/')})`,
                  ).join(', ') || '无'}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <h3>固定随机种子</h3>
        <input value={seed} onChange={(event) => setSeed(event.target.value)} />

        <h3>固定环境（JSON 对象；越出白名单 / 路径逃逸会被服务端 422 拒绝）</h3>
        <textarea value={envText} onChange={(event) => setEnvText(event.target.value)} />

        <h3>固定调度决策（JSON 数组；引用未知调度点或执行体同样会被拒绝）</h3>
        <textarea value={scheduleText} onChange={(event) => setScheduleText(event.target.value)} style={{ minHeight: 180 }} />

        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary" onClick={() => void save()}>保存编辑</button>
          <button onClick={() => void replay()}>执行重放</button>
          <button onClick={() => onMinimize(recipe.id)}>去最小化此配方</button>
        </div>
        {error && <div className="flash-error">{error}</div>}
        {notice && <div className="flash-ok">{notice}</div>}
      </div>

      {outcome && (
        <div className="card">
          <h2>
            重放结果：
            <span className={`pill ${outcome.verdict}`}>{verdictLabel(outcome.verdict)}</span>
          </h2>
          <p className="small muted">
            只有“复现”表示重现了来源失败；“未复现”与“环境不兼容”都不计为通过。
          </p>
          <table className="kv">
            <tbody>
              <tr><td>环境兼容</td><td>{JSON.stringify(outcome.envCompat)}</td></tr>
              <tr><td>退出状态</td><td>{outcome.exitStatus}</td></tr>
              <tr>
                <td>观测签名</td>
                <td>{outcome.observedSignature?.hash ?? '（运行通过，无失败签名）'}</td>
              </tr>
            </tbody>
          </table>
          <h3>stdout</h3>
          <pre className="codeblock">{outcome.stdoutSummary || '（空）'}</pre>
          <h3>stderr</h3>
          <pre className="codeblock">{outcome.stderrSummary || '（空）'}</pre>
        </div>
      )}
    </>
  );
}

function verdictLabel(verdict: ReplayOutcome['verdict']): string {
  switch (verdict) {
    case 'reproduced':
      return '复现';
    case 'not-reproduced':
      return '未复现（不算通过）';
    case 'env-incompatible':
      return '环境不兼容（不算通过）';
  }
}
