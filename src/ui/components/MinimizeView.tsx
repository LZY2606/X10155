import { useEffect, useState } from 'react';
import { api, type StatePayload } from '../api.js';
import type { MinimizationState, MinimizationStep, ReplayRecipe } from '../../core/types.js';

export function MinimizeView({
  state,
  initialRecipeId,
  onChanged,
}: {
  state: StatePayload;
  initialRecipeId: string | null;
  onChanged: () => Promise<void>;
}) {
  const [recipeId, setRecipeId] = useState(initialRecipeId ?? state.recipes[0]?.id ?? '');
  const [budget, setBudget] = useState(24);
  const [minimizationId, setMinimizationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialRecipeId) {
      setRecipeId(initialRecipeId);
    }
  }, [initialRecipeId]);

  const recipe = state.recipes.find((entry) => entry.id === recipeId) ?? null;
  const minimization: MinimizationState | null =
    state.minimizations.find((entry) => entry.id === minimizationId) ?? null;

  const start = async (steps: number, continuation?: MinimizationState) => {
    if (!recipeId) {
      setError('请先选择配方');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.minimize(recipeId, {
        budget,
        continueId: continuation?.id,
        steps,
      });
      setMinimizationId(result.minimization.id);
      await onChanged();
    } catch (startError) {
      setError((startError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="card">
        <h2>逐步最小化重放配方</h2>
        <p className="small muted">
          每一步只尝试删减一个环境项或调度事件，并做恰好一次重放；仍然“复现”才接受。
          预算（重放次数）耗尽时返回当前最小结果，标记为 budget-exhausted，而不是伪称全局最小。
        </p>
        <div className="row">
          <label className="small">
            配方
            <select
              style={{ width: 420, marginTop: 4 }}
              value={recipeId}
              onChange={(event) => {
                setRecipeId(event.target.value);
                setMinimizationId(null);
              }}
            >
              <option value="">— 请选择 —</option>
              {state.recipes.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.fakeTest} · seed={entry.seed} · {entry.id.slice(0, 20)}…
                </option>
              ))}
            </select>
          </label>
          <label className="small">
            预算（重放次数）
            <input
              style={{ width: 110, marginTop: 4 }}
              type="number"
              min={1}
              max={200}
              value={budget}
              onChange={(event) => setBudget(Number(event.target.value))}
            />
          </label>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="primary"
            disabled={busy || !recipe}
            onClick={() => void start(1)}
          >
            建立基线并走 1 步
          </button>
          <button disabled={busy || !minimization || minimization.status !== 'in-progress'} onClick={() => void start(1, minimization ?? undefined)}>
            再走 1 步
          </button>
          <button disabled={busy || !minimization || minimization.status !== 'in-progress'} onClick={() => void start(5, minimization ?? undefined)}>
            连走 5 步
          </button>
          <button disabled={busy || !minimization || minimization.status !== 'in-progress'} onClick={() => void start(200, minimization ?? undefined)}>
            走到预算耗尽 / 固定点
          </button>
        </div>
        {error && <div className="flash-error">{error}</div>}
      </div>

      {minimization && recipe && (
        <MinimizationDetails
          minimization={minimization}
          recipe={recipe}
        />
      )}
    </div>
  );
}

function MinimizationDetails({
  minimization,
  recipe,
}: {
  minimization: MinimizationState;
  recipe: ReplayRecipe;
}) {
  return (
    <>
      <div className="card">
        <h2>
          状态：
          <span className={`pill ${minimization.status}`}>{statusLabel(minimization.status)}</span>
        </h2>
        <table className="kv">
          <tbody>
            <tr><td>已用重放 / 预算</td><td>{minimization.replaysUsed} / {minimization.budget}</td></tr>
            <tr><td>尝试步数（含基线）</td><td>{minimization.steps.length}</td></tr>
            <tr>
              <td>当前配方</td>
              <td>env {Object.keys(minimization.currentRecipe.env).length} 项，
                schedule {minimization.currentRecipe.schedule.length} 事件
              </td>
            </tr>
            <tr><td>当前结论</td><td><span className={`pill ${minimization.currentVerdict}`}>{minimization.currentVerdict}</span></td></tr>
          </tbody>
        </table>
        {minimization.status === 'budget-exhausted' && (
          <p className="small" style={{ color: 'var(--warn)' }}>
            预算已耗尽：以下是“当前最小”的配方。它没有被证明是全局最小；加大预算后可以继续。
          </p>
        )}
        {minimization.status === 'fixed-point' && (
          <p className="small muted">
            到达固定点：按“逐项删环境 / 逐条删调度事件”的操作集，已没有删减后仍复现的候选。
            这是相对于该操作集的局部最小，不宣称全局最小。
          </p>
        )}
      </div>

      <div className="card">
        <h2>证据树（每一步的尝试配方与重放结论）</h2>
        <div>
          {minimization.steps.map((step) => (
            <EvidenceNode
              key={step.index}
              step={step}
              sourceEnvCount={Object.keys(recipe.env).length}
            />
          ))}
        </div>
      </div>

      <div className="card">
        <h2>当前最小配方</h2>
        <pre className="codeblock">{JSON.stringify(minimization.currentRecipe, null, 2)}</pre>
      </div>
    </>
  );
}

function EvidenceNode({
  step,
  sourceEnvCount: _sourceEnvCount,
}: {
  step: MinimizationStep;
  sourceEnvCount: number;
}) {
  void _sourceEnvCount;
  const actionText =
    step.action.kind === 'baseline'
      ? '基线：原始配方重放'
      : step.action.kind === 'remove-env'
        ? `尝试删除环境变量 ${step.action.variable}`
        : `尝试删除调度步骤 step=${step.action.step}`;
  return (
    <div className={`evidence-node ${step.accepted ? 'accepted' : 'rejected'}`}>
      <div className="row">
        <strong>#{step.index}</strong>
        <span>{actionText}</span>
        <span className={`pill ${step.verdict}`}>{step.verdict}</span>
        <span className="pill in-progress">{step.accepted ? '接受，继续删' : '拒绝，回滚'}</span>
        <span className="muted small">第 {step.replaysUsed} 次重放</span>
      </div>
      <details>
        <summary>查看尝试时的配方快照（证据）</summary>
        <pre className="codeblock">{JSON.stringify(step.recipe, null, 2)}</pre>
      </details>
    </div>
  );
}

function statusLabel(status: MinimizationState['status']): string {
  switch (status) {
    case 'in-progress':
      return '进行中';
    case 'fixed-point':
      return '固定点（局部最小）';
    case 'budget-exhausted':
      return '预算耗尽：返回当前最小';
  }
}
