import { useEffect, useState } from "react";
import type { ReplayRecipe, ScheduleStep, VirtualTimeEvent } from "../../core/types.js";

interface Props {
  recipe: ReplayRecipe;
  onSave: (recipe: ReplayRecipe) => Promise<void>;
  readOnly?: boolean;
}

const TEST_OPTIONS = ["suite/queue-drain", "suite/timeout-race"];
const ENV_HINTS: Record<string, string> = {
  WORKDIR: "必须位于 /tmp/flaky-replay-sandbox 或 /var/tmp/flaky-replay-sandbox 下",
  ENABLE_FEATURE_X: "on / off",
  RETRY_COUNT: "0..5（queue-drain 最多 3）",
  TZ: "UTC 或 Area/Location",
};

export function RecipeEditor({ recipe, onSave, readOnly }: Props) {
  const [draft, setDraft] = useState<ReplayRecipe>(recipe);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [envKey, setEnvKey] = useState("WORKDIR");

  useEffect(() => {
    setDraft(recipe);
  }, [recipe]);

  const update = (patch: Partial<ReplayRecipe>) => setDraft((current) => ({ ...current, ...patch }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const setEnv = (key: string, value: string) =>
    update({ env: { ...draft.env, [key]: value } });
  const removeEnv = (key: string) => {
    const env = { ...draft.env };
    delete env[key];
    update({ env });
  };
  const addEnv = () => {
    if (!(envKey in draft.env)) setEnv(envKey, envKey === "ENABLE_FEATURE_X" ? "on" : "");
  };

  const updateScheduleStep = (index: number, patch: Partial<ScheduleStep>) => {
    const schedule = draft.schedule.map((step, i) => (i === index ? { ...step, ...patch } : step));
    update({ schedule });
  };
  const addScheduleStep = () =>
    update({
      schedule: [
        ...draft.schedule,
        { order: draft.schedule.length, actor: "producer", op: "enqueue" },
      ],
    });
  const removeScheduleStep = (index: number) => {
    const schedule = draft.schedule
      .filter((_, i) => i !== index)
      .map((step, i) => ({ ...step, order: i }));
    update({ schedule });
  };

  const updateVirtualEvent = (index: number, patch: Partial<VirtualTimeEvent>) => {
    const virtualTime = draft.virtualTime.map((event, i) =>
      i === index ? { ...event, ...patch } : event,
    );
    update({ virtualTime });
  };
  const addVirtualEvent = () =>
    update({
      virtualTime: [
        ...draft.virtualTime,
        { atMs: 0, kind: draft.testName === "suite/timeout-race" ? "timer-wake" : "timer-arm" },
      ],
    });
  const removeVirtualEvent = (index: number) =>
    update({ virtualTime: draft.virtualTime.filter((_, i) => i !== index) });

  return (
    <div>
      {error && <div className="banner error">{error}</div>}
      <div className="form-grid">
        <label>
          测试（执行器注册表）
          <select
            value={draft.testName}
            disabled={readOnly}
            onChange={(event) => update({ testName: event.target.value })}
          >
            {TEST_OPTIONS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          随机种子
          <input
            type="number"
            value={draft.seed}
            disabled={readOnly}
            onChange={(event) => update({ seed: Number(event.target.value) })}
          />
        </label>
      </div>

      <h4>环境白名单（服务端会再次拒绝越界路径与参数）</h4>
      <table className="data">
        <tbody>
          {Object.entries(draft.env).map(([key, value]) => (
            <tr key={key}>
              <td className="mono">{key}</td>
              <td>
                <input
                  value={value}
                  disabled={readOnly}
                  onChange={(event) => setEnv(key, event.target.value)}
                />
                <span className="hint"> {ENV_HINTS[key] ?? ""}</span>
              </td>
              <td>
                {!readOnly && (
                  <button type="button" className="ghost" onClick={() => removeEnv(key)}>
                    删除
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly && (
        <div className="row">
          <select value={envKey} onChange={(event) => setEnvKey(event.target.value)}>
            {Object.keys(ENV_HINTS).map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
          <button type="button" onClick={addEnv}>
            添加环境项
          </button>
        </div>
      )}

      <h4>调度轨迹</h4>
      <table className="data">
        <thead>
          <tr>
            <th>#</th>
            <th>执行者</th>
            <th>动作</th>
            <th>细节</th>
            {!readOnly && <th />}
          </tr>
        </thead>
        <tbody>
          {draft.schedule.map((step, index) => (
            <tr key={index}>
              <td>{step.order}</td>
              <td>
                <select
                  value={step.actor}
                  disabled={readOnly}
                  onChange={(event) =>
                    updateScheduleStep(index, {
                      actor: event.target.value,
                      op: event.target.value === "producer" ? "enqueue" : "dequeue",
                    })
                  }
                >
                  <option value="producer">producer</option>
                  <option value="consumer">consumer</option>
                </select>
              </td>
              <td>
                <select
                  value={step.op}
                  disabled={readOnly}
                  onChange={(event) => updateScheduleStep(index, { op: event.target.value })}
                >
                  {step.actor === "producer" ? (
                    <option value="enqueue">enqueue</option>
                  ) : (
                    <option value="dequeue">dequeue</option>
                  )}
                </select>
              </td>
              <td>
                <input
                  value={step.detail ?? ""}
                  disabled={readOnly}
                  onChange={(event) => updateScheduleStep(index, { detail: event.target.value })}
                />
              </td>
              {!readOnly && (
                <td>
                  <button type="button" className="ghost" onClick={() => removeScheduleStep(index)}>
                    删除
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly && (
        <button type="button" onClick={addScheduleStep}>
          添加调度事件
        </button>
      )}

      <h4>虚拟时间事件</h4>
      <table className="data">
        <thead>
          <tr>
            <th>atMs</th>
            <th>类型</th>
            <th>细节</th>
            {!readOnly && <th />}
          </tr>
        </thead>
        <tbody>
          {draft.virtualTime.map((event, index) => (
            <tr key={index}>
              <td>
                <input
                  type="number"
                  value={event.atMs}
                  disabled={readOnly}
                  onChange={(eventInput) =>
                    updateVirtualEvent(index, { atMs: Number(eventInput.target.value) })
                  }
                />
              </td>
              <td>
                <select
                  value={event.kind}
                  disabled={readOnly}
                  onChange={(eventInput) =>
                    updateVirtualEvent(index, { kind: eventInput.target.value })
                  }
                >
                  <option value="timer-arm">timer-arm</option>
                  <option value="timer-wake">timer-wake</option>
                  <option value="deadline">deadline</option>
                </select>
              </td>
              <td>
                <input
                  value={event.detail ?? ""}
                  disabled={readOnly}
                  onChange={(eventInput) =>
                    updateVirtualEvent(index, { detail: eventInput.target.value })
                  }
                />
              </td>
              {!readOnly && (
                <td>
                  <button type="button" className="ghost" onClick={() => removeVirtualEvent(index)}>
                    删除
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly && (
        <button type="button" onClick={addVirtualEvent}>
          添加虚拟时间事件
        </button>
      )}

      {!readOnly && (
        <div className="row">
          <button type="button" disabled={saving} onClick={() => void save()}>
            {saving ? "保存中…" : "保存配方（服务端边界校验）"}
          </button>
          <span className="mono small muted">配方 id：{draft.id}</span>
        </div>
      )}
    </div>
  );
}
