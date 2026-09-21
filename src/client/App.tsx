import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Snapshot } from "./api.js";
import { ClusterTab } from "./views/ClusterTab.js";
import { CompareTab } from "./views/CompareTab.js";
import { ImportTab } from "./views/ImportTab.js";
import { RecipeTab } from "./views/RecipeTab.js";

type Tab = "import" | "clusters" | "compare" | "recipes";

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("clusters");
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [comparePair, setComparePair] = useState<[string | null, string | null]>([null, null]);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await api.state());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const showRun = (fingerprint: string) => {
    setSelectedRun(fingerprint);
    setTab("compare");
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: "import", label: "导入 / 导出" },
    { id: "clusters", label: "失败聚类" },
    { id: "compare", label: "比较两条失败" },
    { id: "recipes", label: "重放配方" },
  ];

  return (
    <div className="app">
      <header className="topbar">
        <h1>不稳定测试重放库</h1>
        <div className="meta">
          {snapshot ? (
            <span>
              {snapshot.runs.length} 条原始运行 · {snapshot.clusters.length} 个聚类视图
            </span>
          ) : (
            <span>加载中…</span>
          )}
          <button type="button" onClick={() => void refresh()}>
            刷新
          </button>
        </div>
      </header>

      {error && (
        <div className="banner error">
          {error.split("\n").map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}

      <nav className="tabs">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            className={tab === item.id ? "active" : ""}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <main>
        {!snapshot ? (
          <p>正在连接本地服务…</p>
        ) : (
          <>
            {tab === "import" && <ImportTab snapshot={snapshot} onImported={setSnapshot} />}
            {tab === "clusters" && (
              <ClusterTab snapshot={snapshot} onSelectRun={showRun} onCreateRecipe={() => setTab("recipes")} />
            )}
            {tab === "compare" && (
              <CompareTab
                snapshot={snapshot}
                selected={selectedRun}
                pair={comparePair}
                onPair={setComparePair}
                onOpenRecipes={(fingerprint) => {
                  setSelectedRun(fingerprint);
                  setTab("recipes");
                }}
              />
            )}
            {tab === "recipes" && (
              <RecipeTab snapshot={snapshot} setSnapshot={setSnapshot} initialFingerprint={selectedRun} />
            )}
          </>
        )}
      </main>
    </div>
  );
}
