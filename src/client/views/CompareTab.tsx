import { useMemo, useState } from "react";
import type { Snapshot } from "../api.js";
import { buildSignature } from "../../core/normalize.js";
import type { RuleVersion, StoredRun } from "../../core/types.js";

interface Props {
  snapshot: Snapshot;
  selected: string | null;
  pair: [string | null, string | null];
  onPair: (pair: [string | null, string | null]) => void;
  onOpenRecipes: (fingerprint: string) => void;
}

type DiffKind = "same" | "a" | "b";

function lineDiff(a: string, b: string): Array<{ kind: DiffKind; text: string }> {
  const linesA = a.split("\n");
  const linesB = b.split("\n");
  const result: Array<{ kind: DiffKind; text: string }> = [];
  const max = Math.max(linesA.length, linesB.length);
  for (let i = 0; i < max; i++) {
    const la = linesA[i];
    const lb = linesB[i];
    if (la === lb) result.push({ kind: "same", text: la ?? "" });
    else {
      if (la !== undefined) result.push({ kind: "a", text: la });
      if (lb !== undefined) result.push({ kind: "b", text: lb });
    }
  }
  return result;
}

export function CompareTab({ snapshot, selected, pair, onPair, onOpenRecipes }: Props) {
  const [version, setVersion] = useState<RuleVersion>("rules-v1");
  const effectivePair: [string | null, string | null] = [pair[0], pair[1]];
  const a = snapshot.runs.find((run) => run.fingerprint === effectivePair[0]) ?? null;
  const b = snapshot.runs.find((run) => run.fingerprint === effectivePair[1]) ?? null;

  const diff = useMemo(() => {
    if (!a || !b) return null;
    const sigA = buildSignature(a, version);
    const sigB = buildSignature(b, version);
    return {
      sigA,
      sigB,
      same: sigA.signatureHash === sigB.signatureHash,
      lines: lineDiff(sigA.normalizedSummary, sigB.normalizedSummary),
    };
  }, [a, b, version]);

  const failedRuns = snapshot.runs.filter((run) => run.status !== "pass");

  return (
    <div>
      <div className="grid-two">
        <RunPicker
          label="失败 A"
          runs={failedRuns}
          value={effectivePair[0]}
          onChange={(fingerprint) => onPair([fingerprint, effectivePair[1]])}
        />
        <RunPicker
          label="失败 B"
          runs={failedRuns}
          value={effectivePair[1]}
          onChange={(fingerprint) => onPair([effectivePair[0], fingerprint])}
        />
      </div>

      <div className="row version-row">
        <strong>按规则版本比较：</strong>
        {snapshot.ruleVersions.map((ruleVersion) => (
          <button
            key={ruleVersion}
            type="button"
            className={ruleVersion === version ? "active" : ""}
            onClick={() => setVersion(ruleVersion)}
          >
            {ruleVersion}
          </button>
        ))}
      </div>

      {!a || !b ? (
        <p className="hint">选择两条失败运行进行比较。</p>
      ) : (
        <>
          <div className={`banner ${diff?.same ? "same" : "different"}`}>
            {diff?.same
              ? `同属一个 ${version} 聚类（签名哈希一致）。`
              : `签名不同：归一化后仍存在真实差异（行号 / 错误类型 / 断言值），不会被合并。`}
            <div className="mono small">
              A: {diff?.sigA.signatureHash}
              <br />
              B: {diff?.sigB.signatureHash}
            </div>
          </div>

          <div className="grid-two">
            <TransformCard title="A 的归一化解释" run={a} version={version} />
            <TransformCard title="B 的归一化解释" run={b} version={version} />
          </div>

          <section className="card">
            <h2>归一化文本逐行对比</h2>
            <pre className="diff">
              {diff?.lines.map((line, index) => (
                <div key={index} className={`diff-${line.kind}`}>
                  {line.kind === "a" ? "- " : line.kind === "b" ? "+ " : "  "}
                  {line.text || " "}
                </div>
              ))}
            </pre>
          </section>

          <div className="row">
            <button type="button" onClick={() => onOpenRecipes(a.fingerprint)}>
              用 A 建立/编辑配方
            </button>
            <button type="button" onClick={() => onOpenRecipes(b.fingerprint)}>
              用 B 建立/编辑配方
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function RunPicker({
  label,
  runs,
  value,
  onChange,
}: {
  label: string;
  runs: StoredRun[];
  value: string | null;
  onChange: (fingerprint: string) => void;
}) {
  return (
    <section className="card">
      <h3>{label}</h3>
      <select value={value ?? ""} onChange={(event) => onChange(event.target.value)}>
        <option value="" disabled>
          选择一条失败运行…
        </option>
        {runs.map((run) => (
          <option key={run.fingerprint} value={run.fingerprint}>
            #{run.importSeq} {run.testName} · {run.status} · seed={run.seed ?? "—"}
          </option>
        ))}
      </select>
    </section>
  );
}

function TransformCard({
  title,
  run,
  version,
}: {
  title: string;
  run: StoredRun;
  version: RuleVersion;
}) {
  const signature = buildSignature(run, version);
  return (
    <section className="card">
      <h3>{title}</h3>
      {signature.normalization.transforms.length === 0 ? (
        <p className="hint">未命中噪声规则。</p>
      ) : (
        <ul className="rule-evidence">
          {signature.normalization.transforms.map((transform) => (
            <li key={transform.ruleId}>
              <code>{transform.ruleId}</code> → {transform.replacement}
              <div className="mono small muted">
                {transform.matches.slice(0, 3).map((match) => JSON.stringify(match)).join("  ")}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
