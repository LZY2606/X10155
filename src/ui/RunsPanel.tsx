import { useMemo, useRef, useState } from 'react';
import { api } from './api';
import type { AppProps } from './types-ui';

export function RunsPanel({ state, refresh, notify }: AppProps) {
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const stats = useMemo(() => {
    const failed = state.runs.filter((run) => run.exitStatus !== 0).length;
    return { total: state.runs.length, failed, passed: state.runs.length - failed };
  }, [state.runs]);

  async function doImport() {
    if (!text.trim()) {
      notify('没有可导入的内容', true);
      return;
    }
    try {
      const { report } = await api.importNDJSON(text);
      notify(
        `导入 ${report.imported} 条，跳过重复 ${report.skippedDuplicates} 条` +
          (report.fingerprintConflicts.length
            ? `，指纹冲突 ${report.fingerprintConflicts.length} 条已拒绝`
            : '') +
          (report.errors.length ? `，错误 ${report.errors.length} 行` : ''),
        report.errors.length > 0 || report.fingerprintConflicts.length > 0,
      );
      setText('');
      await refresh();
    } catch (error) {
      notify((error as Error).message, true);
    }
  }

  async function loadSample() {
    try {
      const { report } = await api.loadSample();
      notify(`示例导入 ${report.imported} 条，重复跳过 ${report.skippedDuplicates} 条`);
      await refresh();
    } catch (error) {
      notify((error as Error).message, true);
    }
  }

  async function resetAll() {
    await api.reset();
    notify('已清空服务端持久化数据');
    await refresh();
  }

  function onFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ''));
    reader.readAsText(file);
  }

  async function exportJson() {
    const bundle = await api.downloadExport();
    const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `flaky-vault-export-${new Date().toISOString().slice(0, 19)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    notify('已导出含运行指纹与聚类成员顺序的 JSON 包');
  }

  async function buildFromRun(runId: string) {
    try {
      await api.createRecipe(runId);
      notify(`已从 ${runId} 建立重放配方，请到“重放配方”页查看`);
      await refresh();
    } catch (error) {
      notify((error as Error).message, true);
    }
  }

  return (
    <div>
      <div className="panel">
        <h2>导入 NDJSON 运行记录</h2>
        <p className="muted">
          每行一条结构化运行（测试名、退出状态、stdout 摘要、种子、环境白名单、虚拟时间、调度轨迹）。
          原始记录永不修改；同指纹去重，同 id 不同指纹会被拒绝。
        </p>
        <textarea
          placeholder='{"id":"r01","testName":"...","exitStatus":1,...}'
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="toolbar">
          <button className="primary" onClick={doImport}>
            导入 NDJSON
          </button>
          <button onClick={() => fileRef.current?.click()}>选择文件…</button>
          <button onClick={loadSample}>载入随项目示例</button>
          <button onClick={exportJson}>导出 JSON 包</button>
          <button onClick={resetAll}>清空数据</button>
          <input
            ref={fileRef}
            type="file"
            accept=".ndjson,.txt,.jsonl,application/x-ndjson"
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                onFile(file);
              }
            }}
          />
        </div>
      </div>

      <div className="panel">
        <h2>
          原始运行
          <span className="muted">
            {' '}
  共 {stats.total} 条 · 失败 {stats.failed} · 通过 {stats.passed}
          </span>
        </h2>
        <table>
          <thead>
            <tr>
              <th style={{ width: 60 }}>ID</th>
              <th>测试</th>
              <th style={{ width: 70 }}>状态</th>
              <th style={{ width: 70 }}>种子</th>
              <th style={{ width: 90 }}>耗时</th>
              <th>stdout 摘要</th>
              <th style={{ width: 240 }}>运行指纹</th>
              <th style={{ width: 110 }}></th>
            </tr>
          </thead>
          <tbody>
            {state.runs.map((run) => (
              <tr key={run.id}>
                <td>{run.id}</td>
                <td>
                  <div>{run.testName}</div>
                  <div className="fingerprint">{run.recordedAt}</div>
                </td>
                <td>
                  <span className={`badge ${run.exitStatus === 0 ? 'pass' : 'fail'}`}>
                    {run.exitStatus === 0 ? '通过' : `退出 ${run.exitStatus}`}
                  </span>
                </td>
                <td>{run.seed}</td>
                <td>{run.durationMs} ms</td>
                <td>
                  <pre style={{ maxHeight: 96, overflow: 'auto', margin: 0 }}>
                    {run.stdoutSummary}
                  </pre>
                </td>
                <td className="fingerprint">{state.fingerprints[run.id]}</td>
                <td>
                  <button
                    disabled={run.exitStatus === 0}
                    onClick={() => buildFromRun(run.id)}
                  >
                    建立配方
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
