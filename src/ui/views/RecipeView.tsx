import { useEffect, useState } from "react";
import type {
  ReplayRecipe,
  ReplayResult,
  TestRun,
} from "../../core/types";
import { api } from "../api";

interface Props {
  recipes: ReplayRecipe[];
  runsById: Map<string, TestRun>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChanged: () => Promise<void> | void;
  onMinimize: (recipeId: string, budget: number) => Promise<void>;
}

export function RecipeView({
  recipes,
  runsById,
  selectedId,
  onSelect,
  onChanged,
  onMinimize,
}: Props) {
  const [draft, setDraft] = useState<ReplayRecipe | null>(null);
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [budget, setBudget] = useState(8);

  const selected = recipes.find((recipe) => recipe.id === selectedId) ?? null;

  useEffect(() => {
    setDraft(selected ? structuredClone(selected) : null);
    setResult(null);
  }, [selectedId, selected]);

  if (recipes.length === 0) {
    return (
      <section className="card">
        <h2>重放配方</h2>
        <p className="hint">还没有配方。在“失败聚类”里对一条运行点“建立重放配方”。</p>
      </section>
    );
  }

  return (
    <div className="grid side">
      <section className="card">
        <h2>重放配方</h2>
        <ul className="recipe-list">
          {recipes.map((recipe) => {
            const run = runsById.get(recipe.sourceRunId);
            return (
              <li key={recipe.id}>
                <button
                  type="button"
                  className={
                    recipe.id === selectedId ? "recipe-item active" : "recipe-item"
                  }
                  onClick={() => onSelect(recipe.id)}
                >
                  <strong>{recipe.program}</strong>
                  <small>
                    {recipe.id}
                    {run ? ` · 源 ${run.id}` : ""}
                  </small>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {draft && (
        <section className="card">
          <h2>编辑配方 {draft.id}</h2>
          <div className="grid two">
            <label>
              程序（固定，来自源运行）
              <input value={draft.program} disabled />
            </label>
            <label>
              种子
              <input
                value={draft.seed}
                onChange={(event) =>
                  setDraft({ ...draft, seed: event.target.value })
                }
              />
            </label>
          </div>

          <h3>环境白名单</h3>
          <div className="env-editor">
            {Object.entries(draft.env).map(([key, value]) => (
              <div key={key} className="env-row">
                <input value={key} disabled />
                <input
                  value={value}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      env: { ...draft.env, [key]: event.target.value },
                    })
                  }
                />
                <button
                  type="button"
                  className="mini danger"
                  onClick={() => {
                    const env = { ...draft.env };
                    delete env[key];
                    setDraft({ ...draft, env });
                  }}
                >
                  删除
                </button>
              </div>
            ))}
          </div>

          <h3>调度决策（{draft.schedule.length}）</h3>
          <div className="schedule-editor">
            {draft.schedule.map((decision, index) => (
              <div key={index} className="schedule-row">
                <span className="index">#{index}</span>
                <input
                  value={decision.actor}
                  onChange={(event) => {
                    const schedule = draft.schedule.map((item, i) =>
                      i === index ? { ...item, actor: event.target.value } : item,
                    );
                    setDraft({ ...draft, schedule });
                  }}
                />
                <select
                  value={decision.kind}
                  onChange={(event) => {
                    const schedule = draft.schedule.map((item, i) =>
                      i === index
                        ? {
                            ...item,
                            kind: event.target.value as typeof item.kind,
                          }
                        : item,
                    );
                    setDraft({ ...draft, schedule });
                  }}
                >
                  {["wake", "yield", "lock-acquire", "signal"].map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
                <input
                  className="chosen"
                  type="number"
                  value={decision.chosen}
                  onChange={(event) => {
                    const schedule = draft.schedule.map((item, i) =>
                      i === index
                        ? { ...item, chosen: Number(event.target.value) }
                        : item,
                    );
                    setDraft({ ...draft, schedule });
                  }}
                />
                <button
                  type="button"
                  className="mini danger"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      schedule: draft.schedule.filter((_, i) => i !== index),
                    })
                  }
                >
                  删除
                </button>
              </div>
            ))}
          </div>

          <div className="row wrap">
            <button
              type="button"
              className="primary"
              onClick={async () => {
                await api.saveRecipe(draft);
                await onChanged();
              }}
            >
              保存配方
            </button>
            <button
              type="button"
              onClick={async () => setResult(await api.replay(draft.id))}
            >
              执行重放
            </button>
            <label className="budget">
              最小化预算
              <input
                type="number"
                min={1}
                max={500}
                value={budget}
                onChange={(event) => setBudget(Number(event.target.value))}
              />
            </label>
            <button
              type="button"
              onClick={async () => {
                await api.saveRecipe(draft);
                await onChanged();
                await onMinimize(draft.id, budget);
              }}
            >
              开始逐步最小化
            </button>
            <button
              type="button"
              className="ghost danger"
              onClick={async () => {
                if (!confirm("删除该配方？")) return;
                await api.deleteRecipe(draft.id);
                onSelect(null);
                await onChanged();
              }}
            >
              删除配方
            </button>
          </div>

          {result && <ReplayResultPanel result={result} />}
        </section>
      )}
    </div>
  );
}

function ReplayResultPanel({ result }: { result: ReplayResult }) {
  const label =
    result.outcome === "reproduced"
      ? "复现"
      : result.outcome === "not-reproduced"
        ? "未复现（不算通过）"
        : "环境不兼容（不算通过）";
  return (
    <div className={`replay-result outcome-${result.outcome}`}>
      <h3>
        重放结果：<span className={`pill pill-${result.outcome}`}>{label}</span>
        {result.matchedSignature && <span className="pill">签名匹配</span>}
      </h3>
      <pre>{result.stdoutSummary}</pre>
      {result.reason && <p className="hint">{result.reason}</p>}
    </div>
  );
}
