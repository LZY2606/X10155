import { randomUUID } from 'node:crypto';
import type {
  EvidenceNode,
  MinimizeAction,
  MinimizeState,
  ReplayOutcome,
  ReplayRecipe,
} from './types.js';

export type ReplayFn = (recipe: ReplayRecipe) => ReplayOutcome;

/** 全部删减候选：逐个环境项、逐条调度事件、逐条虚拟时间事件。 */
export function candidatesOf(recipe: ReplayRecipe): MinimizeAction[] {
  const actions: MinimizeAction[] = [];
  for (const key of Object.keys(recipe.env)) {
    actions.push({ type: 'remove-env', key });
  }
  recipe.schedule.forEach((event, i) => {
    actions.push({ type: 'remove-schedule-event', key: `${i}:${event}` });
  });
  recipe.virtualTime.forEach((event, i) => {
    actions.push({ type: 'remove-virtual-time-event', key: `${i}:${event}` });
  });
  return actions;
}

function cloneRecipe(recipe: ReplayRecipe): ReplayRecipe {
  return {
    ...recipe,
    args: [...recipe.args],
    env: { ...recipe.env },
    declaredTempPaths: [...recipe.declaredTempPaths],
    virtualTime: [...recipe.virtualTime],
    schedule: [...recipe.schedule],
  };
}

/** 应用一次删减，返回新配方；不修改原配方。 */
export function applyAction(recipe: ReplayRecipe, action: MinimizeAction): ReplayRecipe {
  const next = cloneRecipe(recipe);
  if (action.type === 'remove-env') {
    delete next.env[action.key];
  } else if (action.type === 'remove-schedule-event') {
    const index = Number(action.key.split(':')[0]);
    next.schedule.splice(index, 1);
  } else {
    const index = Number(action.key.split(':')[0]);
    next.virtualTime.splice(index, 1);
  }
  return next;
}

function summaryOf(recipe: ReplayRecipe) {
  return {
    envKeys: Object.keys(recipe.env).sort(),
    schedule: [...recipe.schedule],
    virtualTime: [...recipe.virtualTime],
  };
}

function rootEvidence(recipe: ReplayRecipe): EvidenceNode {
  return {
    id: randomUUID(),
    parentId: null,
    step: 0,
    action: null,
    outcome: 'root',
    kept: true,
    recipeSummary: summaryOf(recipe),
  };
}

/** 初始化最小化会话。 */
export function createMinimizeState(recipe: ReplayRecipe, budget: number): MinimizeState {
  return {
    recipeId: recipe.id,
    budget,
    usedSteps: 0,
    status: 'idle',
    isGlobalMinimum: false,
    pending: candidatesOf(recipe),
    current: cloneRecipe(recipe),
    evidence: [rootEvidence(recipe)],
  };
}

/**
 * 执行一步最小化：尝试删减掉下一个候选并重放。
 * - 仍复现 → 接受删减（证据 kept=true）
 * - 未复现/环境不兼容 → 回滚（证据 kept=false）
 * 预算耗尽时返回当前最小结果，status=budget_exhausted，
 * isGlobalMinimum 保持 false —— 绝不伪称全局最小。
 */
export function minimizeStep(state: MinimizeState, replay: ReplayFn): MinimizeState {
  if (state.status === 'complete' || state.status === 'budget_exhausted') return state;
  if (state.pending.length === 0) {
    state.status = 'complete';
    state.isGlobalMinimum = true;
    return state;
  }
  if (state.usedSteps >= state.budget) {
    state.status = 'budget_exhausted';
    state.isGlobalMinimum = false;
    return state;
  }
  state.status = 'running';
  const action = state.pending.shift()!;
  const trial = applyAction(state.current, action);
  const outcome = replay(trial);
  const kept = outcome.reproduced;
  if (kept) state.current = trial;
  const parent = [...state.evidence].reverse().find((n) => n.kept) ?? state.evidence[0]!;
  state.evidence.push({
    id: randomUUID(),
    parentId: parent.id,
    step: state.usedSteps + 1,
    action,
    outcome: outcome.kind,
    kept,
    recipeSummary: summaryOf(state.current),
  });
  state.usedSteps += 1;
  if (state.pending.length === 0) {
    state.status = 'complete';
    state.isGlobalMinimum = true;
  } else if (state.usedSteps >= state.budget) {
    state.status = 'budget_exhausted';
    state.isGlobalMinimum = false;
  }
  return state;
}

/** 连续执行直到完成或预算耗尽。 */
export function minimizeAll(state: MinimizeState, replay: ReplayFn): MinimizeState {
  while (state.status !== 'complete' && state.status !== 'budget_exhausted') {
    minimizeStep(state, replay);
  }
  return state;
}
