import { useState } from 'react';
import { api } from './api';
import { ENV_ALLOWLIST } from '../core/recipe';
import type {
  ReplayRecipe,
  ReplayResult,
  ScheduleEvent,
} from '../core/types';
import type { AppProps } from './types-ui';

function outcomeBadge(outcome: ReplayResult['outcome']) {
  if (outcome === 'reproduced') {
    return <span className="badge repro">复现 reproduced</span>;
  }
  if (outcome === 'not-reproduced') {
    return <span className="badge norepro">未复现 not-reproduced（不算通过）</span>;
  }
  return <span className="badge incompat">环境不兼容（不算通过）</span>;
}

export function RecipesPanel({ state, refresh, notify }: AppProps) {
  const [selectedId, setSelectedId] = useState<string>(state.recipes[0]?.id ?? '');
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [seedText, setSeedText] = useState('');
  const [envDraft, setEnvDraft] = useState<Record<string, string>>({});
  const [scheduleText, setScheduleText] = useState('');
  const [editing, setEditing] = useState(false);

  const recipe: ReplayRecipe | undefined =
    state.recipes.find((entry) => entry.id === selectedId) ?? state.recipes[0];

  function startEdit(current: ReplayRecipe) {
    setEditing(true);
    setSeedText(String(current.seed));
    setEnvDraft({ ...current.env });
    setScheduleText(JSON.stringify(current.schedule, null, 2));
    setResult(null);
  }

  async function saveEdit(current: ReplayRecipe) {
    let schedule: ScheduleEvent[];
    try {
      schedule = JSON.parse(scheduleText) as ScheduleEvent[];
    } catch (error) {
      notify(`调度 JSON 非法：${(error as Error).message}`, true);
      return;
    }
    try {
      await api.updateRecipe(current.id, {
        seed: Number(seedText),
        env: envDraft,
        schedule,
      });
      setEditing(false);
      notify('配方已更新（服务端重新执行白名单校验）');
      await refresh();
    } catch (error) {
      notify((error as Error).message, true);
    }
  }

  async function attemptEscape(current: ReplayRecipe) {
    // 演示：浏览器无法通过路径/参数让服务端越出假执行器。
    try {
      await api.updateRecipe(current.id, {
        env: { ...current.env, TMPDIR_ROOT: '/private/tmp/../../etc' },
      });
      notify('意外：逃逸路径被接受了？这不应该发生', true);
    } catch (error) {
      notify(`服务端拒绝路径逃逸：${(error as Error).message}`);
    }
  }

  async function replay(current: ReplayRecipe) {
    try {
      const { result: replayResult } = await api.replay(current.id);
      setResult(replayResult);
    } catch (error) {
      notify((error as Error).message, true);
    }
  }

  if (!recipe) {
    return (
      <div className="panel">
        <h2>重放配方</h2>
        <p className="muted">
          还没有配方。先到“原始运行”页从任意失败运行建立一个，或载入随项目示例。
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>编辑并重放配方</h2>
      <div className="row" style={{ marginBottom: 12 }}>
        <select
          value={recipe.id}
          onChange={(event) => {
            setSelectedId(event.target.value);
            setEditing(false);
            setResult(null);
          }}
        >
          {state.recipes.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.id}（{entry.testId}，源 {entry.sourceRunId}）
            </option>
          ))}
        </select>
        <button className="primary" onClick={() => replay(recipe)}>
          在假执行器上重放
        </button>
        {!editing ? (
          <button onClick={() => startEdit(recipe)}>编辑配方</button>
        ) : (
          <button className="primary" onClick={() => saveEdit(recipe)}>
            保存编辑
          </button>
        )}
        <button onClick={() => attemptEscape(recipe)}>
          尝试路径逃逸（应被拒绝）
        </button>
      </div>

      <div className="kv" style={{ marginBottom: 8 }}>
        固定 testId：<b>{recipe.testId}</b>（必须是注册的假测试） · 目标签名{' '}
        <b>{recipe.targetSignature}</b>（{recipe.targetPackId}@v
        {recipe.targetPackVersion}）
      </div>

      {!editing ? (
        <div className="grid2">
          <div>
            <h3>固定环境（白名单）</h3>
            <pre>{JSON.stringify(recipe.env, null, 2)}</pre>
          </div>
          <div>
            <h3>固定调度决策（{recipe.schedule.length} 个事件）</h3>
            <pre>{JSON.stringify(recipe.schedule, null, 2)}</pre>
          </div>
        </div>
      ) : (
        <div className="grid2">
          <div>
            <h3>种子</h3>
            <input value={seedText} onChange={(event) => setSeedText(event.target.value)} />
            <h3 style={{ marginTop: 12 }}>
              环境（键限白名单：{ENV_ALLOWLIST.join(', ')}）
            </h3>
            {Object.keys(envDraft).map((key) => (
              <div className="row" key={key} style={{ marginBottom: 6 }}>
                <code>{key}</code>
                <input
                  value={envDraft[key] ?? ''}
                  onChange={(event) =>
                    setEnvDraft({ ...envDraft, [key]: event.target.value })
                  }
                />
                <button
                  onClick={() => {
                    const next = { ...envDraft };
                    delete next[key];
                    setEnvDraft(next);
                  }}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
          <div>
            <h3>调度事件（JSON）</h3>
            <textarea
              style={{ minHeight: 240 }}
              value={scheduleText}
              onChange={(event) => setScheduleText(event.target.value)}
            />
          </div>
        </div>
      )}

      {result && (
        <div style={{ marginTop: 12 }}>
          <h3>重放结果 {outcomeBadge(result.outcome)}</h3>
          <div className="kv">
            退出状态 <b>{result.exitStatus}</b> · 耗时 <b>{result.durationMs} ms</b> ·
            观察签名 <b>{result.observedSignature ?? '—'}</b>
          </div>
          {result.incompatibilities.length > 0 && (
            <ul>
              {result.incompatibilities.map((reason) => (
                <li key={reason} className="temp-hit">
                  {reason}
                </li>
              ))}
            </ul>
          )}
          <pre>{result.stdoutSummary || '（环境不兼容，执行器未运行该测试）'}</pre>
        </div>
      )}
    </div>
  );
}
