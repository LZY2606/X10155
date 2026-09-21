import { useCallback, useEffect, useState } from 'react';
import { api, type VaultState } from './api';
import { ClustersPanel } from './ClustersPanel';
import { ComparePanel } from './ComparePanel';
import { MinimizePanel } from './MinimizePanel';
import { RecipesPanel } from './RecipesPanel';
import { RunsPanel } from './RunsPanel';
import type { TabId } from './types-ui';

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'runs', label: '原始运行 / 导入' },
  { id: 'clusters', label: '失败聚类' },
  { id: 'compare', label: '比较两条失败' },
  { id: 'recipes', label: '重放配方' },
  { id: 'minimize', label: '逐步最小化 / 证据树' },
];

export function App() {
  const [state, setState] = useState<VaultState | null>(null);
  const [tab, setTab] = useState<TabId>('runs');
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);

  const refresh = useCallback(async () => {
    setState(await api.state());
  }, []);

  const notify = useCallback((message: string, error = false) => {
    setToast({ message, error });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  useEffect(() => {
    refresh().catch((error) => notify((error as Error).message, true));
  }, [refresh, notify]);

  if (!state) {
    return (
      <>
        <header className="app-header">
          <h1>不稳定测试重放库</h1>
        </header>
        <div className="layout">正在加载服务端状态…</div>
      </>
    );
  }

  const props = { state, refresh, notify };

  return (
    <>
      <header className="app-header">
        <h1>不稳定测试重放库</h1>
        <p>
          结构化运行记录 → 可解释失败签名聚类 → 固定种子/环境/调度的重放配方 →
          带证据树的逐步最小化。浏览器不接触任何 shell 或真实命令。
        </p>
      </header>
      <div className="layout">
        <nav className="tabs">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              className={tab === entry.id ? 'active' : ''}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>
        {tab === 'runs' && <RunsPanel {...props} />}
        {tab === 'clusters' && <ClustersPanel {...props} />}
        {tab === 'compare' && <ComparePanel {...props} />}
        {tab === 'recipes' && <RecipesPanel {...props} />}
        {tab === 'minimize' && <MinimizePanel {...props} />}
      </div>
      {toast && (
        <div className={`toast ${toast.error ? 'error' : ''}`}>{toast.message}</div>
      )}
    </>
  );
}
