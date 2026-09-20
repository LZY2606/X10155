import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  MinimizeSession,
  ReplayRecipe,
  RuleVersion,
  TestRun,
} from "../core/types";
import { api, type StateResponse } from "./api";
import { ImportView } from "./views/ImportView";
import { ClusterView } from "./views/ClusterView";
import { CompareView } from "./views/CompareView";
import { RecipeView } from "./views/RecipeView";
import { MinimizeView } from "./views/MinimizeView";

type Tab = "import" | "clusters" | "compare" | "recipes" | "minimize";

const TABS: { id: Tab; label: string }[] = [
  { id: "import", label: "导入 / 运行" },
  { id: "clusters", label: "失败聚类" },
  { id: "compare", label: "比较失败" },
  { id: "recipes", label: "重放配方" },
  { id: "minimize", label: "逐步最小化" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("clusters");
  const [state, setState] = useState<StateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewVersion, setViewVersion] = useState<RuleVersion>("v1");
  const [selectedRunIds, setSelectedRunIds] = useState<[string?, string?]>([
    undefined,
    undefined,
  ]);
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<MinimizeSession | null>(
    null,
  );

  const refresh = useCallback(async (version?: RuleVersion) => {
    const next = await api.state(version);
    setState(next);
    setViewVersion(next.activeRuleVersion);
  }, []);

  useEffect(() => {
    refresh().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, [refresh]);

  const runs = state?.runs ?? [];
  const recipes = state?.recipes ?? [];
  const clusters = state?.clusters ?? [];

  const selectRun = useCallback((id: string, slot: 0 | 1) => {
    setSelectedRunIds((prev) => {
      const next: [string?, string?] = [prev[0], prev[1]];
      next[slot] = id;
      return next;
    });
  }, []);

  const openRecipe = useCallback(
    async (runId: string) => {
      const recipe = await api.createRecipe(runId);
      await refresh();
      setSelectedRecipeId(recipe.id);
      setTab("recipes");
    },
    [refresh],
  );

  const startMinimize = useCallback(
    async (recipeId: string, budget: number) => {
      const created = await api.minimize(recipeId, budget);
      await refresh();
      setActiveSession(created.session);
      setTab("minimize");
    },
    [refresh],
  );

  const runsById = useMemo(() => {
    const map = new Map<string, TestRun>();
    for (const run of runs) map.set(run.id, run);
    return map;
  }, [runs]);

  const recipesById = useMemo(() => {
    const map = new Map<string, ReplayRecipe>();
    for (const recipe of recipes) map.set(recipe.id, recipe);
    return map;
  }, [recipes]);

  return (
    <div className="app">
      <header className="topbar">
        <h1>不稳定测试重放库</h1>
        <div className="topbar-right">
          <label className="rule-switch">
            聚类视图规则
            <select
              value={viewVersion}
              onChange={async (event) => {
                const version = event.target.value as RuleVersion;
                await api.setRuleVersion(version);
                setViewVersion(version);
                await refresh(version);
              }}
            >
              {(state?.ruleVersions ?? ["v1", "v2"]).map((version) => (
                <option key={version} value={version}>
                  {version}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="ghost"
            onClick={async () => {
              if (!confirm("重置为随项目提交的示例运行？")) return;
              await api.reset();
              await refresh();
              setActiveSession(null);
            }}
          >
            重置示例数据
          </button>
        </div>
      </header>

      {error && (
        <div className="banner error" onClick={() => setError(null)}>
          {error}（点击关闭）
        </div>
      )}

      <nav className="tabs">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={tab === item.id ? "tab active" : "tab"}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <main className="content">
        {!state && <p>加载中…</p>}
        {state && tab === "import" && (
          <ImportView
            runs={runs}
            onImported={async () => refresh()}
            onCompare={(id, slot) => {
              selectRun(id, slot);
              setTab("compare");
            }}
          />
        )}
        {state && tab === "clusters" && (
          <ClusterView
            clusters={clusters}
            runsById={runsById}
            version={viewVersion}
            onSelectRun={(id) => {
              selectRun(id, 0);
              setTab("compare");
            }}
            onReplay={openRecipe}
          />
        )}
        {state && tab === "compare" && (
          <CompareView
            runs={runs}
            selected={selectedRunIds}
            onSelect={selectRun}
          />
        )}
        {state && tab === "recipes" && (
          <RecipeView
            recipes={recipes}
            runsById={runsById}
            selectedId={selectedRecipeId}
            onSelect={setSelectedRecipeId}
            onChanged={async () => refresh()}
            onMinimize={startMinimize}
          />
        )}
        {state && tab === "minimize" && (
          <MinimizeView
            recipes={recipes}
            recipesById={recipesById}
            sessions={state.sessions}
            activeSession={activeSession}
            onSession={setActiveSession}
            onChanged={async () => refresh()}
          />
        )}
      </main>
    </div>
  );
}

