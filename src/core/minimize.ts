import type {
  EvidenceNode,
  MinimizeSession,
  MinimizeStep,
  ReplayOutcome,
  ReplayRecipe,
  TestRun,
} from "./types";
import { cloneRecipe } from "./recipe";
import { replayRecipe } from "./replay";

export interface MinimizeConfig {
  id: string;
  recipe: ReplayRecipe;
  targetRun: TestRun;
  budget: number;
}

interface CandidateItem {
  kind: "env" | "schedule";
  /** Stable identity across deletions: "env:<KEY>" or "schedule:<ORIGINDEX>". */
  id: string;
  /** Human label shown in the evidence tree. */
  label: string;
}

function initialQueue(recipe: ReplayRecipe): {
  queue: string[];
  scheduleOrigins: number[];
} {
  const envIds = Object.keys(recipe.env)
    .sort()
    .map((key) => `env:${key}`);
  const scheduleIds = recipe.schedule.map((_, index) => `schedule:${index}`);
  return {
    queue: [...envIds, ...scheduleIds],
    scheduleOrigins: recipe.schedule.map((_, index) => index),
  };
}

function removeById(
  recipe: ReplayRecipe,
  scheduleOrigins: number[],
  id: string,
): { recipe: ReplayRecipe; scheduleOrigins: number[] } {
  const next = cloneRecipe(recipe);
  if (id.startsWith("env:")) {
    delete next.env[id.slice(4)];
    return { recipe: next, scheduleOrigins };
  }
  const origin = Number(id.slice(9));
  const currentIndex = scheduleOrigins.indexOf(origin);
  next.schedule = next.schedule.filter((_, i) => i !== currentIndex);
  return {
    recipe: next,
    scheduleOrigins: scheduleOrigins.filter((_, i) => i !== currentIndex),
  };
}

/**
 * Stepwise minimizer: each step deletes exactly one env entry or schedule
 * event, replays, and keeps the deletion only when the failure still
 * reproduces. Every attempt (accepted or rejected) becomes evidence.
 *
 * When the replay budget is exhausted the session stops and returns the
 * current smallest recipe; globalMinimumClaimed stays false because we never
 * finished proving it.
 */
export function createSession(config: MinimizeConfig): MinimizeSession {
  const { queue, scheduleOrigins } = initialQueue(config.recipe);
  return {
    id: config.id,
    recipeId: config.recipe.id,
    targetSignature: "",
    budget: config.budget,
    attemptsUsed: 0,
    status: "running",
    steps: [],
    currentRecipeId: config.recipe.id,
    evidenceTree: {
      id: `${config.id}:root`,
      label: "原始配方（已复现）",
      outcome: "reproduced",
      accepted: true,
      children: [],
    },
    globalMinimumClaimed: false,
    queue,
    scheduleOrigins,
  };
}

export interface MinimizeTickResult {
  session: MinimizeSession;
  recipe: ReplayRecipe;
  attempt?: {
    outcome: ReplayOutcome;
    accepted: boolean;
  };
}

export function minimizationTick(
  session: MinimizeSession,
  recipe: ReplayRecipe,
  targetRun: TestRun,
): MinimizeTickResult {
  if (session.status !== "running") {
    return { session, recipe };
  }
  if (session.attemptsUsed >= session.budget) {
    return { session: { ...session, status: "budget-exhausted" }, recipe };
  }

  let candidate: CandidateItem | null = null;
  let nextQueue = [...session.queue];
  while (nextQueue.length > 0) {
    const id = nextQueue[0];
    const found = findCandidate(recipe, session.scheduleOrigins, id);
    nextQueue = nextQueue.slice(1);
    if (found) {
      candidate = found;
      break;
    }
    // Item already absent (removed in an earlier accepted step): skip without
    // spending replay budget.
  }

  if (!candidate) {
    // Every surviving item has individually been proven necessary.
    return {
      session: { ...session, status: "complete", queue: [], globalMinimumClaimed: false },
      recipe,
    };
  }

  const removal = removeById(recipe, session.scheduleOrigins, candidate.id);
  const result = replayRecipe(removal.recipe, targetRun);
  const attemptsUsed = session.attemptsUsed + 1;
  const accepted = result.outcome === "reproduced";

  const step: MinimizeStep = {
    index: session.steps.length,
    itemKind: candidate.kind,
    itemKey: candidate.id,
    outcome: result.outcome,
    accepted,
    reason:
      result.reason ??
      (accepted ? "删除后仍复现，永久移除" : "删除后失败不再复现，恢复该项"),
    snapshotRecipeId: removal.recipe.id,
  };

  const evidenceNode: EvidenceNode = {
    id: `${session.id}:step:${step.index}`,
    label: candidate.label,
    removed: {
      kind: candidate.kind,
      key: candidate.id.startsWith("env:")
        ? candidate.id.slice(4)
        : candidate.id.slice(9),
    },
    outcome: result.outcome,
    accepted,
    stepIndex: step.index,
    children: [],
  };

  const nextRecipe = accepted ? removal.recipe : recipe;
  const nextOrigins = accepted
    ? removal.scheduleOrigins
    : session.scheduleOrigins;

  const nextSession: MinimizeSession = {
    ...session,
    attemptsUsed,
    steps: [...session.steps, step],
    currentRecipeId: nextRecipe.id,
    queue: nextQueue,
    scheduleOrigins: nextOrigins,
    evidenceTree: {
      ...session.evidenceTree,
      children: [...session.evidenceTree.children, evidenceNode],
    },
  };

  if (attemptsUsed >= session.budget) {
    nextSession.status = "budget-exhausted";
  }

  return {
    session: nextSession,
    recipe: nextRecipe,
    attempt: { outcome: result.outcome, accepted },
  };
}

function findCandidate(
  recipe: ReplayRecipe,
  origins: number[],
  id: string,
): CandidateItem | null {
  if (id.startsWith("env:")) {
    const key = id.slice(4);
    if (!(key in recipe.env)) return null;
    return { kind: "env", id, label: `删除环境项 ${key}` };
  }
  const origin = Number(id.slice(9));
  const currentIndex = origins.indexOf(origin);
  if (currentIndex < 0) return null;
  const decision = recipe.schedule[currentIndex];
  return {
    kind: "schedule",
    id,
    label: `删除调度事件 #${origin} (${decision.actor}/${decision.kind})`,
  };
}
