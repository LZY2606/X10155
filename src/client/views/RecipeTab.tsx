import { useEffect, useMemo, useState } from "react";
import { api, type Snapshot } from "../api.js";
import type { ReplayRecipe, ReplayResult } from "../../core/types.js";
import { RecipeEditor } from "./RecipeEditor.js";
import { MinimizerPanel } from "./MinimizerPanel.js";

interface Props {
  snapshot: Snapshot;
  setSnapshot: (snapshot: Snapshot) => void;
  initialFingerprint: string | null;
}

export function RecipeTab({ snapshot, setSnapshot, initialFingerprint }: Props) {
  const recipes = Object.values(snapshot.recipes).sort((a, b) =>
    a.derivedFromFingerprint === b.derivedFromFingerprint
      ? a.id < b.id
        ? -1
        : 1
      : 0,
  );
  const [selectedId, setSelectedId] = useState<string | null>(recipes[0]?.id ?? null);
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedId && recipes[0]) setSelectedId(recipes[0].id);
  }, [recipes, selectedId]);

  // 从别的页带着运行指纹跳来时，自动建立配方。
  useEffect(() => {
    if (!initialFingerprint) return;
    const existing = recipes.find((recipe) => recipe.derivedFromFingerprint === initialFingerprint);
    if (existing) {
      setSelectedId(existing.id);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const created = await api.createRecipe(initialFingerprint);
        if (!cancelled) {
          setSnapshot(created.state);
          setSelectedId(created.recipe.id);
        }
      } catch (err) {
        if (!cancelled) setNotice((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFingerprint]);

  const selected = recipes.find((recipe) => recipe.id === selectedId) ?? null;

  const runByFp = useMemo(
    () => new Map(snapshot.runs.map((run) => [run.fingerprint, run])),
    [snapshot.runs],
  );

  const replay = async (recipe: ReplayRecipe) => {
    setBusy(recipe.id);
    setNotice(null);
    try {
      const response = await api.replay(recipe.id);
      setResult(response.result);
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = async (recipe: ReplayRecipe) => {
    const response = await api.putRecipe(recipe);
    setSnapshot(response.state);
    setSelectedId(response.recipe.id);
    setNotice("配方已通过服务端边界校验并保存（内容变化会得到新 id，旧配方保留）。");
  };

  return (
    <div className="grid-two wide-left">
      <section className="card">
        <h2>配方</h2>
        {recipes.length === 0 && <p className="hint">还没有配方。到“失败聚类”里从一条运行建立。</p>}
        <ul className="recipe-list">
          {recipes.map((recipe) => {
            const run = runByFp.get(recipe.derivedFromFingerprint);
            return (
              <li key={recipe.id}>
                <button
                  type="button"
                  className={recipe.id === selectedId ? "active" : ""}
                  onClick={() => {
                    setSelectedId(recipe.id);
                    setResult(null);
                  }}
                >
                  <div>{recipe.testName}</div>
                  <div className="mono small muted">
                    seed={recipe.seed} · #{run?.importSeq ?? "?"} · {recipe.id.slice(0, 14)}…
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <div>
        {notice && <div className="banner">{notice}</div>}
        {selected && (
          <>
            <section className="card">
              <h2>编辑重放配方</h2>
              <p className="hint">
                固定种子、环境白名单与调度决策。保存只能落到随库的确定性假执行器
                （{selected.executorVersion}）——路径或参数越界会被服务端拒绝，浏览器无法触发任意命令执行。
              </p>
              <RecipeEditor recipe={selected} onSave={save} />
              <div className="row">
                <button
                  type="button"
                  disabled={busy === selected.id}
                  onClick={() => void replay(selected)}
                >
                  {busy === selected.id ? "重放中…" : "重放"}
                </button>
              </div>
              {result && <ReplayResultCard result={result} />}
            </section>

            <MinimizerPanel
              recipe={selected}
              minimizers={snapshot.minimizers}
              runFingerprint={selected.derivedFromFingerprint}
              onChange={setSnapshot}
            />
          </>
        )}
      </div>
    </div>
  );
}

function ReplayResultCard({ result }: { result: ReplayResult }) {
  const label =
    result.outcome === "reproduced"
      ? "复现 reproduced"
      : result.outcome === "not-reproduced"
        ? "未复现 not-reproduced（不能算通过）"
        : "环境不兼容 environment-incompatible（不能算通过）";
  return (
    <div className={`banner outcome-banner-${result.outcome}`}>
      <strong>{label}</strong>
      <div className="mono small muted">
        exit={result.exitStatus}/{result.exitCode} · {result.executorVersion}
        {result.matchedSignature ? ` · 命中签名 ${result.matchedSignature.slice(0, 18)}…` : ""}
      </div>
      {result.incompatibilityReason && <div>原因：{result.incompatibilityReason}</div>}
      <details>
        <summary>执行器输出</summary>
        <pre className="summary small">{`${result.stdoutSummary}\n${result.stderrSummary}`}</pre>
      </details>
    </div>
  );
}
