import { useState } from "react";
import { api } from "../api.js";
import type {
  MinimizerNode,
  MinimizerState,
  ReplayRecipe,
  ReplayResult,
  RuleVersion,
} from "../../core/types.js";

interface Props {
  recipe: ReplayRecipe;
  minimizers: Record<string, MinimizerState>;
  runFingerprint: string;
  onChange: (snapshot: Awaited<ReturnType<typeof api.state>>) => void;
}

const STATUS_LABEL: Record<MinimizerState["status"], string> = {
  initial: "起点未能复现",
  "in-progress": "最小化进行中",
  "single-removal-minimal": "单项删除已最小",
  "budget-exhausted-current-minimum": "预算耗尽 · 当前最小",
};

export function MinimizerPanel({ recipe, minimizers, runFingerprint, onChange }: Props) {
  const related = Object.values(minimizers)
    .filter((state) => state.nodes[0]?.recipe.id === recipe.id)
    .sort((a, b) => (a.id < b.id ? 1 : -1));
  const [activeId, setActiveId] = useState<string | null>(related[related.length - 1]?.id ?? null);
  const [budget, setBudget] = useState(8);
  const [ruleVersion, setRuleVersion] = useState<RuleVersion>("rules-v1");
  const [steps, setSteps] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const active = related.find((state) => state.id === activeId) ?? null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.minimize(recipe.id, budget, ruleVersion);
      setActiveId(result.minimizer.id);
      onChange(result.state);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const advance = async () => {
    if (!active) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.advance(active.id, steps);
      onChange(result.state);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h3>逐步最小化（每步都保留证据）</h3>
      <div className="row wrap">
        <label>
          规则版本{" "}
          <select value={ruleVersion} onChange={(event) => setRuleVersion(event.target.value as RuleVersion)}>
            <option value="rules-v1">rules-v1</option>
            <option value="rules-v2">rules-v2</option>
          </select>
        </label>
        <label>
          预算（重放次数）{" "}
          <input
            type="number"
            min={1}
            max={1000}
            value={budget}
            onChange={(event) => setBudget(Number(event.target.value))}
          />
        </label>
        <button type="button" disabled={busy} onClick={() => void start()}>
          {busy ? "…" : "开始最小化"}
        </button>
      </div>
      {error && <div className="banner error">{error}</div>}

      {related.length > 0 && (
        <div className="row">
          <label>
            会话{" "}
            <select value={activeId ?? ""} onChange={(event) => setActiveId(event.target.value)}>
              {related.map((state) => (
                <option key={state.id} value={state.id}>
                  {state.id}（{STATUS_LABEL[state.status]}）
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {active && (
        <>
          <div className={`banner ${active.status.includes("exhausted") ? "warn" : active.status === "single-removal-minimal" ? "same" : ""}`}>
            状态：{STATUS_LABEL[active.status]} · 已尝试 {active.attempts} 次 · 预算剩余{" "}
            {active.budgetRemaining}/{active.budget}
            {active.status === "budget-exhausted-current-minimum" && (
              <div>预算已耗尽：这是当前最小配方，不宣称全局最小。</div>
            )}
          </div>
          <div className="row">
            <label>
              每次推进{" "}
              <input
                type="number"
                min={1}
                max={100}
                value={steps}
                onChange={(event) => setSteps(Number(event.target.value))}
              />{" "}
              步
            </label>
            <button
              type="button"
              disabled={busy || active.status === "single-removal-minimal" || active.status === "budget-exhausted-current-minimum"}
              onClick={() => void advance()}
            >
              推进
            </button>
          </div>
          <EvidenceTree state={active} />
        </>
      )}
    </section>
  );
}

function EvidenceTree({ state }: { state: MinimizerState }) {
  const byParent = new Map<string | null, MinimizerNode[]>();
  for (const node of state.nodes) {
    const list = byParent.get(node.parentId) ?? [];
    list.push(node);
    byParent.set(node.parentId, list);
  }
  return (
    <div className="tree">
      <TreeLevel parentId={null} depth={0} byParent={byParent} state={state} />
    </div>
  );
}

function TreeLevel({
  parentId,
  depth,
  byParent,
  state,
}: {
  parentId: string | null;
  depth: number;
  byParent: Map<string | null, MinimizerNode[]>;
  state: MinimizerState;
}) {
  const nodes = byParent.get(parentId) ?? [];
  return (
    <ul>
      {nodes.map((node) => (
        <li key={node.id}>
          <NodeCard node={node} isCurrent={node.recipe.id === state.currentMinimalRecipeId} />
          <div style={{ paddingLeft: `${depth + 1}rem` }}>
            <TreeLevel parentId={node.recipe.id} depth={depth + 1} byParent={byParent} state={state} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function NodeCard({ node, isCurrent }: { node: MinimizerNode; isCurrent: boolean }) {
  const replay = node.replay;
  const outcome: ReplayResult["outcome"] | "—" = replay?.outcome ?? "—";
  const removal =
    node.removal === null
      ? "起点"
      : node.removal.kind === "env"
        ? `删除环境 ${node.removal.key}=${node.removal.value}`
        : `删除调度 #${node.removal.index}（${node.removal.step.actor}:${node.removal.step.op}）`;
  return (
    <div className={`tree-node ${node.accepted ? "accepted" : node.removal ? "rejected" : "root"} ${isCurrent ? "current" : ""}`}>
      <div className="row">
        <span className={`badge outcome-${outcome}`}>{outcome}</span>
        <strong>{removal}</strong>
        {isCurrent && <span className="badge">当前最小</span>}
      </div>
      <div className="muted">{node.reason}</div>
      <details>
        <summary>证据：配方与执行器输出（预算剩余 {node.budgetRemaining}）</summary>
        <RecipeSummary recipe={node.recipe} />
        {replay && (
          <pre className="summary small">
            {`exit=${replay.exitStatus}/${replay.exitCode}\n${replay.stdoutSummary}\n${replay.stderrSummary}`}
          </pre>
        )}
      </details>
    </div>
  );
}

function RecipeSummary({ recipe }: { recipe: ReplayRecipe }) {
  return (
    <div className="mono small muted">
      seed={recipe.seed} · env={JSON.stringify(recipe.env)} · schedule=
      {recipe.schedule.map((step) => `${step.actor[0]}${step.op[0]}`).join(",") || "<empty>"} ·
      virtual={recipe.virtualTime.map((event) => `${event.kind}@${event.atMs}`).join(",") || "<empty>"}
    </div>
  );
}
