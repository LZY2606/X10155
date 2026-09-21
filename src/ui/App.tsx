import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type StatePayload } from './api.js';
import { ImportView } from './components/ImportView.js';
import { ClustersView } from './components/ClustersView.js';
import { CompareView } from './components/CompareView.js';
import { RecipeView } from './components/RecipeView.js';
import { MinimizeView } from './components/MinimizeView.js';
import { RunsView } from './components/RunsView.js';

type Page = 'clusters' | 'import' | 'compare' | 'recipes' | 'minimize' | 'runs';

const PAGES: Array<{ id: Page; label: string }> = [
  { id: 'clusters', label: '失败聚类' },
  { id: 'compare', label: '比较两条失败' },
  { id: 'recipes', label: '重放配方' },
  { id: 'minimize', label: '逐步最小化 / 证据树' },
  { id: 'runs', label: '原始运行' },
  { id: 'import', label: '导入 / 导出 NDJSON' },
];

export function App() {
  const [page, setPage] = useState<Page>('clusters');
  const [state, setState] = useState<StatePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [selectedRecipe, setSelectedRecipe] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await api.state());
      setError(null);
    } catch (refreshError) {
      setError((refreshError as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runs = state?.runs ?? [];
  const failedCount = useMemo(
    () => runs.filter(({ run }) => run.exitStatus !== 0).length,
    [runs],
  );

  const goCompare = (fingerprint: string) => {
    setSelectedRun(fingerprint);
    setPage('compare');
  };
  const goRecipe = (recipeId: string) => {
    setSelectedRecipe(recipeId);
    setPage('recipes');
  };

  return (
    <>
      <header className="app-header">
        <h1>不稳定测试重放库</h1>
        <p>
          结构化运行记录 · 版本化归一化规则 · 失败签名聚类 · 确定性假执行器重放 ·
          有预算、有证据的最小化
        </p>
      </header>
      <div className="layout">
        <nav className="sidebar">
          {PAGES.map((item) => (
            <button
              key={item.id}
              className={`nav-btn ${page === item.id ? 'active' : ''}`}
              onClick={() => setPage(item.id)}
            >
              {item.label}
              {item.id === 'runs' && (
                <span className="nav-count">{runs.length} 条 / {failedCount} 失败</span>
              )}
              {item.id === 'clusters' && (
                <span className="nav-count">
                  {state
                    ? `v${state.rulesetVersion}：${state.clusterViews.find(
                        (view) => view.rulesetVersion === state.rulesetVersion,
                      )?.clusters.length ?? 0} 簇`
                    : ''}
                </span>
              )}
              {item.id === 'recipes' && (
                <span className="nav-count">{state?.recipes.length ?? 0}</span>
              )}
            </button>
          ))}
          <p className="small muted" style={{ marginTop: 18 }}>
            重放只会命中随项目提交的确定性假执行器；浏览器无法让服务端执行任意命令或越出沙箱路径。
          </p>
        </nav>
        <main className="content">
          {error && <div className="flash-error">请求失败：{error}</div>}
          {!state ? (
            <p className="muted">加载中…</p>
          ) : (
            <>
              {page === 'clusters' && (
                <ClustersView state={state} onCompare={goCompare} onRecipe={goRecipe} />
              )}
              {page === 'compare' && (
                <CompareView
                  state={state}
                  initialFingerprint={selectedRun}
                  onRecipe={goRecipe}
                />
              )}
              {page === 'recipes' && (
                <RecipeView
                  state={state}
                  initialRecipeId={selectedRecipe}
                  onChanged={refresh}
                  onMinimize={(id) => {
                    setSelectedRecipe(id);
                    setPage('minimize');
                  }}
                />
              )}
              {page === 'minimize' && (
                <MinimizeView state={state} initialRecipeId={selectedRecipe} onChanged={refresh} />
              )}
              {page === 'runs' && <RunsView state={state} onCompare={goCompare} onRecipe={goRecipe} />}
              {page === 'import' && <ImportView state={state} onImported={refresh} />}
            </>
          )}
        </main>
      </div>
    </>
  );
}
