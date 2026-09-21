import { replayRecipe } from "./recipe.js";
import type {
  MinimizerNode,
  MinimizerState,
  MinimizerStatus,
  ReplayRecipe,
  ReplayResult,
  RuleVersion,
  ScheduleStep,
} from "./types.js";

export interface MinimizerOptions {
  id: string;
  runFingerprint: string;
  ruleVersion: RuleVersion;
  baseRecipe: ReplayRecipe;
  budget: number;
}

interface AttemptKey {
  recipeId: string;
  removal: MinimizerNode["removal"];
}

function attemptKeyString(key: AttemptKey): string {
  return JSON.stringify(key);
}

function makeNode(params: {
  id: string;
  parentId: string | null;
  recipe: ReplayRecipe;
  replay: ReplayResult;
  removal: MinimizerNode["removal"];
  budgetRemaining: number;
}): MinimizerNode {
  const reproduced = params.replay.outcome === "reproduced";
  return {
    id: params.id,
    parentId: params.parentId,
    recipe: params.recipe,
    replay: params.replay,
    accepted: reproduced,
    rejected: !reproduced,
    removal: params.removal,
    reason:
      params.removal === null
        ? "起点配方（完整环境与调度）"
        : reproduced
          ? "删除后仍然复现：接受并继续"
          : params.replay.outcome === "environment-incompatible"
            ? `删除后执行器报环境不兼容：保留（${params.replay.incompatibilityReason ?? ""}）`
            : "删除后不再复现：该成分是必需的，保留",
    budgetRemaining: params.budgetRemaining,
  };
}

/**
 * 逐步最小化：每一步删除一个环境项或一个调度事件，立即重放并留下证据。
 * 预算耗尽时返回“当前最小”，状态显式标记，绝不伪称全局最小。
 */
export function initMinimizer(options: MinimizerOptions): MinimizerState {
  if (options.budget <= 0) throw new Error("最小化预算必须为正整数");
  const rootReplay = replayRecipe(options.baseRecipe);
  const root = makeNode({
    id: "n0",
    parentId: null,
    recipe: options.baseRecipe,
    replay: rootReplay,
    removal: null,
    budgetRemaining: options.budget - 1,
  });
  return {
    id: options.id,
    runFingerprint: options.runFingerprint,
    ruleVersion: options.ruleVersion,
    nodes: [root],
    currentMinimalRecipeId: options.baseRecipe.id,
    attempts: 1,
    budget: options.budget,
    budgetRemaining: options.budget - 1,
    status: rootReplay.outcome === "reproduced" ? "in-progress" : "initial",
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

function cloneWithoutEnv(recipe: ReplayRecipe, key: string): ReplayRecipe {
  const env = { ...recipe.env };
  delete env[key];
  const { id: _omit, ...body } = recipe;
  return {
    ...body,
    env,
    // 内容变化 → 新确定性 id，见 recipe.withRecipeId 的同构哈希。
    id: `recipe-min-${shortHash(JSON.stringify({ from: recipe.id, dropEnv: key }))}`,
  };
}

function cloneWithoutSchedule(recipe: ReplayRecipe, index: number): ReplayRecipe {
  const schedule: ScheduleStep[] = recipe.schedule
    .filter((_, i) => i !== index)
    .map((step, i) => ({ ...step, order: i }));
  const { id: _omit, ...body } = recipe;
  return {
    ...body,
    schedule,
    id: `recipe-min-${shortHash(JSON.stringify({ from: recipe.id, dropSchedule: index }))}`,
  };
}

function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

interface Candidate {
  recipe: ReplayRecipe;
  removal: MinimizerNode["removal"];
}

function nextCandidate(state: MinimizerState, tried: Set<string>): Candidate | null {
  const current = state.nodes.find((node) => node.recipe.id === state.currentMinimalRecipeId);
  if (!current) return null;
  const recipe = current.recipe;

  // 固定尝试顺序：先环境键（字母序），再调度事件（自后向前，先试删除尾部决策）。
  for (const key of Object.keys(recipe.env).sort()) {
    const removal: MinimizerNode["removal"] = {
      kind: "env",
      key,
      value: recipe.env[key] ?? "",
    };
    const keyStr = attemptKeyString({ recipeId: recipe.id, removal });
    if (!tried.has(keyStr)) return { recipe: cloneWithoutEnv(recipe, key), removal };
  }
  for (let index = recipe.schedule.length - 1; index >= 0; index--) {
    const step = recipe.schedule[index];
    if (!step) continue;
    const removal: MinimizerNode["removal"] = { kind: "schedule", index, step };
    const keyStr = attemptKeyString({ recipeId: recipe.id, removal });
    if (!tried.has(keyStr)) {
      return { recipe: cloneWithoutSchedule(recipe, index), removal };
    }
  }
  return null;
}

/** 推进最小化至多 maxSteps 步；可多次调用直到终态。 */
export function advanceMinimizer(state: MinimizerState, maxSteps = 1): MinimizerState {
  const next: MinimizerState = {
    ...state,
    nodes: [...state.nodes],
  };
  const tried = new Set<string>();

  let steps = 0;
  while (steps < maxSteps && next.status !== "single-removal-minimal") {
    if (next.budgetRemaining <= 0) {
      next.status = "budget-exhausted-current-minimum";
      break;
    }
    const candidate = nextCandidate(next, tried);
    if (!candidate) {
      next.status = "single-removal-minimal";
      break;
    }
    tried.add(attemptKeyString({ recipeId: next.currentMinimalRecipeId, removal: candidate.removal }));

    const replay = replayRecipe(candidate.recipe);
    next.attempts += 1;
    next.budgetRemaining -= 1;
    const node = makeNode({
      id: `n${next.attempts - 1}`,
      parentId: next.currentMinimalRecipeId,
      recipe: candidate.recipe,
      replay,
      removal: candidate.removal,
      budgetRemaining: next.budgetRemaining,
    });
    next.nodes.push(node);
    if (node.accepted) {
      next.currentMinimalRecipeId = candidate.recipe.id;
    }
    steps += 1;
  }

  // 预算恰好用完时，若还未证明单项最小，按“当前最小”如实返回。
  if (next.status === "in-progress" && next.budgetRemaining <= 0) {
    next.status = "budget-exhausted-current-minimum";
  }
  next.updatedAt = "1970-01-01T00:00:00.000Z";
  return next;
}

export function isTerminal(status: MinimizerStatus): boolean {
  return status === "single-removal-minimal" || status === "budget-exhausted-current-minimum";
}
