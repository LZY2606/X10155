import { useRef, useState } from 'react';
import { api, type StatePayload } from '../api.js';

const SAMPLE = `{
  "testName": "suite/queue-order-flake",
  "exitStatus": 1,
  "stdoutSummary": "queue capacity=2\\nscratch: /tmp/pytest-of-me/new-session/jobs.json\\ndelivery order: beta,beta\\ntook 33ms",
  "stderrSummary": "AssertionError: queue delivery order mismatch\\n  expected: alpha,beta\\n  actual:   beta,beta\\n  at tests/queue_test.ts:42",
  "seed": "ad-hoc-sample",
  "startedAt": "2026-09-22T10:00:00.000Z",
  "durationMs": 612,
  "tempPathRoots": ["/tmp/pytest-of-me/new-session"],
  "envWhitelist": { "REPLAY_MODE": "replay" },
  "virtualTimeEvents": [
    { "seq": 0, "kind": "yield", "atMs": 4, "detail": { "actor": "consumer-B" } }
  ],
  "scheduleDecisions": [
    { "step": 0, "point": "queue", "resource": "job-queue", "selected": "consumer-B", "waiters": ["consumer-A", "consumer-B"] },
    { "step": 1, "point": "queue", "resource": "job-queue", "selected": "consumer-B", "waiters": ["consumer-A", "consumer-B"] }
  ],
  "error": {
    "type": "AssertionError",
    "message": "queue delivery order mismatch",
    "file": "tests/queue_test.ts",
    "line": 42,
    "assertion": { "expected": "alpha,beta", "actual": "beta,beta", "operator": "deepEqual" }
  }
}`;

export function ImportView({
  state: _state,
  onImported,
}: {
  state: StatePayload;
  onImported: () => Promise<void>;
}) {
  void _state;
  const [text, setText] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const doImport = async () => {
    setMessage(null);
    try {
      const result = await api.importNdjson(text);
      setMessage({ kind: 'ok', text: `导入成功，新增 ${result.imported.length} 条运行（重复指纹自动跳过）。` });
      setText('');
      await onImported();
    } catch (error) {
      setMessage({ kind: 'error', text: (error as Error).message });
    }
  };

  const onFile = async (file: File) => {
    setText(await file.text());
  };

  return (
    <div>
      <div className="card">
        <h2>导入 NDJSON</h2>
        <p className="small muted">
          每行一条结构化运行记录。非法行会整批拒绝并报告行号；重复内容指纹幂等跳过。
          导出的 NDJSON 自带 fingerprint，重新导入时会校验指纹一致性。
        </p>
        <textarea
          placeholder='粘贴 NDJSON（每行一个 JSON 对象）…'
          value={text}
          onChange={(event) => setText(event.target.value)}
          style={{ minHeight: 200 }}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary" onClick={() => void doImport()}>导入</button>
          <input
            ref={fileRef}
            type="file"
            accept=".ndjson,.jsonl,.txt,application/x-ndjson"
            style={{ width: 'auto' }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void onFile(file);
              }
            }}
          />
          <button onClick={() => setText(SAMPLE)}>填入一条示例</button>
          <a className="btn" href="/api/export" download="runs.ndjson">导出全部为 NDJSON</a>
        </div>
        {message && (
          <div className={message.kind === 'ok' ? 'flash-ok' : 'flash-error'}>
            {message.text}
          </div>
        )}
      </div>

      <div className="card">
        <h2>指纹与顺序保证</h2>
        <ul className="small muted">
          <li>运行指纹是记录内容的确定性哈希，与导入时间无关。</li>
          <li>导出严格按首次导入顺序排列；聚类成员也保持同一顺序，重新导入/重建视图结果稳定。</li>
          <li>数据持久化在服务端 data/store.json，重启后运行、配方、聚类视图与最小化证据都保留。</li>
        </ul>
      </div>
    </div>
  );
}
