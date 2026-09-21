import { describe, expect, it } from "vitest";
import { advanceMinimizer, initMinimizer } from "../src/core/minimizer.js";
import { recipeFromRun, replayRecipe, withExpectedSignatures } from "../src/core/recipe.js";
import { emptyStore, importNdjson } from "../src/core/store.js";
import { readFileSync } from "node:fs";

function loadFirstRecipe(index: number) {
  const ndjson = readFileSync(new URL("../samples/runs.ndjson", import.meta.url), "utf8");
  const store = importNdjson(emptyStore(), ndjson).state;
  const run = store.runs[index]!;
  return withExpectedSignatures(recipeFromRun(run), run);
}

describe("逐步最小化", () => {
  it("每一步都留下证据，接受的删除会移动当前最小", () => {
    const recipe = loadFirstRecipe(0);
    const initial = initMinimizer({
      id: "min-1",
      runFingerprint: recipe.derivedFromFingerprint,
      ruleVersion: "rules-v1",
      baseRecipe: recipe,
      budget: 20,
    });
    expect(initial.status).toBe("in-progress");
    expect(initial.nodes[0]?.removal).toBeNull();

    const after = advanceMinimizer(initial, 3);
    expect(after.nodes).toHaveLength(4);
    for (const node of after.nodes) {
      expect(node.replay).not.toBeNull();
      expect(node.budgetRemaining).toBeGreaterThanOrEqual(0);
    }
    // 至少有一个删除被接受或被拒绝；被拒绝的节点必须解释原因。
    const rejected = after.nodes.filter((node) => node.rejected);
    for (const node of rejected) expect(node.reason.length).toBeGreaterThan(0);
  });

  it("删光环境与调度后仍能如实报告：不兼容或未复现都不是复现", () => {
    const recipe = loadFirstRecipe(0);
    let state = initMinimizer({
      id: "min-2",
      runFingerprint: recipe.derivedFromFingerprint,
      ruleVersion: "rules-v1",
      baseRecipe: recipe,
      budget: 40,
    });
    while (state.status === "in-progress") {
      const next = advanceMinimizer(state, 1);
      if (next === state) break;
      state = next;
    }
    expect(["single-removal-minimal", "budget-exhausted-current-minimum"]).toContain(state.status);
    const current = state.nodes.find((node) => node.recipe.id === state.currentMinimalRecipeId)!;
    expect(current.replay?.outcome).toBe("reproduced");
  });

  it("预算耗尽时返回当前最小，不伪称全局最小", () => {
    const recipe = loadFirstRecipe(0);
    let state = initMinimizer({
      id: "min-3",
      runFingerprint: recipe.derivedFromFingerprint,
      ruleVersion: "rules-v1",
      baseRecipe: recipe,
      budget: 3,
    });
    state = advanceMinimizer(state, 5);
    expect(state.status).toBe("budget-exhausted-current-minimum");
    expect(state.budgetRemaining).toBe(0);
    expect(state.nodes.length).toBeLessThanOrEqual(3);
    const current = state.nodes.find((node) => node.recipe.id === state.currentMinimalRecipeId)!;
    expect(replayRecipe(current.recipe).outcome).toBe("reproduced");
  });

  it("起点配方不复现时拒绝开始最小化", () => {
    const passing = {
      testName: "suite/queue-drain",
      status: "pass",
      exitCode: 0,
      stdoutSummary: "PASS suite/queue-drain\nqueue drained: enqueues=2 dequeues=2 emptyPolls=0\nseed=12 pid=41005 took 16ms",
      stderrSummary: "",
      seed: 12,
      env: { WORKDIR: "/tmp/flaky-replay-sandbox/job-5", ENABLE_FEATURE_X: "on" },
      tempPathPrefixes: ["/tmp/flaky-replay-sandbox/job-5"],
      durationMs: 16,
      schedule: [
        { order: 0, actor: "producer", op: "enqueue" },
        { order: 1, actor: "consumer", op: "dequeue" },
        { order: 2, actor: "producer", op: "enqueue" },
        { order: 3, actor: "consumer", op: "dequeue" },
      ],
      virtualTime: [],
    };
    const store = importNdjson(emptyStore(), JSON.stringify(passing)).state;
    const run = store.runs[0]!;
    const recipe = withExpectedSignatures(recipeFromRun(run), run);
    const state = initMinimizer({
      id: "min-4",
      runFingerprint: recipe.derivedFromFingerprint,
      ruleVersion: "rules-v1",
      baseRecipe: recipe,
      budget: 10,
    });
    expect(state.status).toBe("initial");
  });

  it("证据树可沿 parentId 回溯到起点", () => {
    const recipe = loadFirstRecipe(0);
    let state = initMinimizer({
      id: "min-5",
      runFingerprint: recipe.derivedFromFingerprint,
      ruleVersion: "rules-v1",
      baseRecipe: recipe,
      budget: 20,
    });
    state = advanceMinimizer(state, 4);
    const root = state.nodes[0]!;
    let cursor = state.nodes[state.nodes.length - 1]!;
    let hops = 0;
    while (cursor.parentId !== null && hops < 10) {
      const parent = state.nodes.find((node) => node.recipe.id === cursor.parentId);
      expect(parent).toBeDefined();
      cursor = parent!;
      hops += 1;
    }
    expect(cursor.id).toBe(root.id);
  });
});
