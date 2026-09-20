import { useMemo, useState } from "react";
import type {
  EvidenceNode,
  MinimizeSession,
  ReplayRecipe,
} from "../../core/types";
import { api } from "../api";

interface Props {
  recipes: ReplayRecipe[];
  recipesById: Map<string, ReplayRecipe>;
  sessions: MinimizeSession[];
  activeSession: MinimizeSession | null;
  onSession: (session: MinimizeSession | null) => void;
  onChanged: () => Promise<void> | void;
}

const STATUS_TEXT: Record<MinimizeSession["status"], string> = {
  running: "运行中（还有候选项）",
  "budget-exhausted": "预算耗尽：返回当前最小结果，未声称全局最小",
  complete: "完成：单步删除邻域内每项都已证明必要",
};

export function MinimizeView({
  recipes,
  recipesById,
  sessions,
  activeSession,
  onSession,
  onChanged,
}: Props) {
  const [selectedRecipe, setSelectedRecipe] = useState(
    recipes[0]?.id ?? "",
  );
  const [budget, setBudget] = useState(6);
  const [stepping, setStepping] = useState(false);
  const [lastTick, setLastTick] = useState<string | null>(null);

  const session = activeSession;
  const recipe = session ? recipesById.get(session.recipeId) : null;
  const steps = session?.steps ?? [];
  const removedCount = steps.filter((step) => step.accepted).length;

  const tree = useMemo(() => session?.evidenceTree ?? null, [session]);

  async function step() {
    if (!session) return;
    setStepping(true);
    try {
      const tick = await api.minimizeStep(session.id);
      onSession(tick.session);
      await onChanged();
      if (tick.attempt) {
        setLastTick(
          `${tick.attempt.accepted ? "接受删除" : "保留该项"}：${tick.attempt.outcome}`,
        );
      }
    } finally {
      setStepping(false);
    }
  }

  async function runAll() {
    if (!session) return;
    let guard = 0;
    while (guard < session.budget + 1) {
      const tick = await api.minimizeStep(session.id);
      onSession(tick.session);
      await onChanged();
      if (
        tick.session.status !== "running" ||
        !tick.attempt
      ) {
        break;
      }
      guard++;
    }
  }

  return (
    <div className="grid side">
      <section className="card">
        <h2>逐步最小化</h2>
        {recipes.length === 0 ? (
          <p className="hint">先为一条失败运行建立配方。</p>
        ) : (
          <>
            <label>
              配方
              <select
                value={selectedRecipe}
                onChange={(event) => setSelectedRecipe(event.target.value)}
              >
                {recipes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id} ({item.program})
                  </option>
                ))}
              </select>
            </label>
            <label>
              重放预算（最多尝试次数）
              <input
                type="number"
                min={1}
                max={500}
                value={budget}
                onChange={(event) => setBudget(Number(event.target.value))}
              />
            </label>
            <div className="row">
              <button
                type="button"
                className="primary"
                onClick={async () => {
                  const created = await api.minimize(selectedRecipe, budget);
                  onSession(created.session);
                  setLastTick(null);
                  await onChanged();
                }}
              >
                新建最小化会话
              </button>
            </div>
            {sessions.length > 0 && (
              <>
                <h3>历史会话</h3>
                <ul className="recipe-list">
                  {sessions.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={
                          session?.id === item.id
                            ? "recipe-item active"
                            : "recipe-item"
                        }
                        onClick={() => onSession(item)}
                      >
                        {item.id}
                        <small>
                          {item.status} · {item.attemptsUsed}/{item.budget}
                        </small>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </section>

      <section className="card">
        <h2>证据树与当前最小配方</h2>
        {!session || !recipe ? (
          <p className="hint">选择配方并新建会话后，可逐步删减环境项与调度事件。</p>
        ) : (
          <>
            <div className="min-status">
              <span className={`pill pill-${session.status}`}>
                {STATUS_TEXT[session.status]}
              </span>
              <span>
                已用 {session.attemptsUsed}/{session.budget} 次重放 · 已移除{" "}
                {removedCount} 项
              </span>
              {session.status === "budget-exhausted" && (
                <strong className="warn">未声称全局最小</strong>
              )}
              {session.status === "complete" && (
                <span>globalMinimumClaimed=false（仅局部单步最小）</span>
              )}
            </div>
            <div className="row">
              <button
                type="button"
                className="primary"
                disabled={stepping || session.status !== "running"}
                onClick={step}
              >
                {stepping ? "重放中…" : "执行一步"}
              </button>
              <button
                type="button"
                disabled={session.status !== "running"}
                onClick={runAll}
              >
                跑到预算/完成
              </button>
              {lastTick && <span className="hint">{lastTick}</span>}
            </div>

            <h3>证据树（每一步都保留）</h3>
            {tree && <EvidenceTreeView node={tree} depth={0} />}

            <h3>步骤记录</h3>
            <table className="steps-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>删除项</th>
                  <th>重放结果</th>
                  <th>处置</th>
                  <th>证据/原因</th>
                </tr>
              </thead>
              <tbody>
                {steps.map((itemStep) => (
                  <tr key={itemStep.index}>
                    <td>{itemStep.index}</td>
                    <td>
                      {itemStep.itemKind}:{itemStep.itemKey}
                    </td>
                    <td>
                      <span className={`pill pill-${itemStep.outcome}`}>
                        {itemStep.outcome}
                      </span>
                    </td>
                    <td>{itemStep.accepted ? "永久移除" : "恢复"}</td>
                    <td className="reason">{itemStep.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>当前最小配方</h3>
            <pre className="recipe-snapshot">
              {JSON.stringify(
                {
                  id: recipe.id,
                  seed: recipe.seed,
                  env: recipe.env,
                  schedule: recipe.schedule,
                  args: recipe.args,
                },
                null,
                2,
              )}
            </pre>
          </>
        )}
      </section>
    </div>
  );
}

function EvidenceTreeView({
  node,
  depth,
}: {
  node: EvidenceNode;
  depth: number;
}) {
  return (
    <div className="evidence-node" style={{ marginLeft: depth * 18 }}>
      <div className={`evidence-line evidence-${node.outcome}`}>
        <span className="node-label">{node.label}</span>
        <span className={`pill pill-${node.outcome}`}>{node.outcome}</span>
        <span className="accepted">{node.accepted ? "✓ 接受" : "✗ 拒绝"}</span>
      </div>
      {node.children.map((child) => (
        <EvidenceTreeView key={child.id} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}
