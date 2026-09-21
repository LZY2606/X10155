import { useState } from 'react';
import { api } from './api';
import type { EvidenceNode, MinimizeSession } from '../core/types';
import type { AppProps } from './types-ui';

function statusBadge(status: MinimizeSession['status']) {
  switch (status) {
    case 'minimized':
      return <span className="badge pass">逐步删减完毕（序列意义上的最小）</span>;
    case 'budget-exhausted':
      return <span className="badge norepro">预算耗尽：返回当前最小结果（非全局最小声明）</span>;
    case 'reproducing':
      return <span className="badge">最小化进行中</span>;
    case 'could-not-reproduce':
      return <span className="badge norepro">基线未复现，无法最小化</span>;
    case 'environment-incompatible':
      return <span className="badge incompat">环境不兼容，无法最小化</span>;
  }
}

function nodeKindLabel(node: EvidenceNode) {
  switch (node.kind) {
    case 'baseline':
      return '基线';
    case 'remove-env':
      return '接受：删环境项';
    case 'remove-schedule':
      return '接受：删调度事件';
    case 'accepted':
      return '接受';
    case 'rejected':
      return '拒绝（删减后不再复现）';
  }
}

function EvidenceTree({ node }: { node: EvidenceNode }) {
  return (
    <div className="tree-node">
      <div>
        <b>
          #{node.step} {nodeKindLabel(node)}
        </b>{' '}
        <span className="muted">{node.description}</span>
      </div>
      <div className="kv" style={{ margin: '4px 0' }}>
        重放：
        {node.replay.outcome === 'reproduced' ? (
          <span className="badge repro">复现</span>
        ) : node.replay.outcome === 'not-reproduced' ? (
          <span className="badge norepro">未复现</span>
        ) : (
          <span className="badge incompat">环境不兼容</span>
        )}{' '}
        删除项：{node.removedKeys.length ? node.removedKeys.join(', ') : '（无）'}
      </div>
      {node.children.map((child) => (
        <EvidenceTree key={child.nodeId} node={child} />
      ))}
    </div>
  );
}

export function MinimizePanel({ state, notify }: AppProps) {
  const [recipeId, setRecipeId] = useState(state.recipes[0]?.id ?? '');
  const [budget, setBudget] = useState(24);
  const [session, setSession] = useState<MinimizeSession | null>(null);

  const recipe =
    state.recipes.find((entry) => entry.id === recipeId) ?? state.recipes[0];

  async function start() {
    if (!recipe) {
      notify('请先建立配方', true);
      return;
    }
    try {
      const { session: started } = await api.minimizeStart(recipe.id, budget);
      setSession(started);
      if (started.status !== 'reproducing') {
        notify(`基线结果为 ${started.status}，不会进入删减`);
      }
    } catch (error) {
      notify((error as Error).message, true);
    }
  }

  async function step() {
    if (!session) {
      return;
    }
    const { session: next } = await api.minimizeStep(session.sessionId);
    setSession(next);
  }

  async function runAll() {
    if (!session) {
      return;
    }
    const { session: next } = await api.minimizeRun(session.sessionId);
    setSession(next);
  }

  return (
    <div className="panel">
      <h2>逐步最小化配方</h2>
      <p className="muted">
        按“环境项 → 调度事件”的顺序逐项删减；每删一项都重放一次并把结果挂到证据树。
        预算是重放次数上限，耗尽即停止并返回当前最小结果——不会伪称全局最小。
      </p>
      <div className="row" style={{ marginBottom: 12 }}>
        <select
          value={recipe?.id ?? ''}
          onChange={(event) => {
            setRecipeId(event.target.value);
            setSession(null);
          }}
        >
          {state.recipes.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.id}（{entry.testId}）
            </option>
          ))}
        </select>
        <label className="kv">
          重放预算：{' '}
          <input
            type="number"
            min={1}
            max={200}
            value={budget}
            style={{ width: 80 }}
            onChange={(event) => setBudget(Number(event.target.value))}
          />
        </label>
        <button className="primary" onClick={start}>
          开始（先跑基线）
        </button>
        <button disabled={!session} onClick={step}>
          单步删减
        </button>
        <button disabled={!session} onClick={runAll}>
          跑到结束/预算
        </button>
      </div>

      {session && (
        <>
          <div className="row" style={{ marginBottom: 10 }}>
            {statusBadge(session.status)}
            <span className="kv">
              已用重放 <b>{session.replaysUsed}</b>/<b>{session.budget}</b> · 步骤{' '}
              <b>{session.step}</b>
            </span>
          </div>
          <div className="grid2">
            <div>
              <h3>当前最小配方</h3>
              <pre>{JSON.stringify(
                {
                  testId: session.currentRecipe.testId,
                  seed: session.currentRecipe.seed,
                  env: session.currentRecipe.env,
                  schedule: session.currentRecipe.schedule,
                },
                null,
                2,
              )}</pre>
            </div>
            <div>
              <h3>证据树</h3>
              <div style={{ maxHeight: 420, overflow: 'auto' }}>
                <EvidenceTree node={session.evidence} />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
