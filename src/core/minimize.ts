import type {
  EvidenceNode,
  MinimizeResult,
  Recipe,
  ReplayOutcome,
  RunRecord,
} from "./types.js";
import type { ReplayResult } from "./types.js";

export type ReplayFn = (recipe: Recipe) => Promise<ReplayResult>;

interface Candidate {
  kind: "env" | "schedule";
  key: string;
  index?: number;
}

function cloneRecipe(recipe: Recipe): Recipe {
  return {
    ...recipe,
    env: { ...recipe.env },
    schedule: [...recipe.schedule],
    virtualTimeEvents: [...recipe.virtualTimeEvents],
    args: [...recipe.args],
  };
}

function applyRemoval(recipe: Recipe, c: Candidate): Recipe {
  const next = cloneRecipe(recipe);
  if (c.kind === "env") {
    delete next.env[c.key];
  } else {
    next.schedule.splice(c.index!, 1);
  }
  return next;
}

export async function minimizeRecipe(
  baseRecipe: Recipe,
  replayFn: ReplayFn,
  budget: number,
): Promise<MinimizeResult> {
  let current = cloneRecipe(baseRecipe);
  const evidence: EvidenceNode[] = [];
  const root: EvidenceNode = {
    id: "e0",
    parentId: null,
    action: "初始配方（未删减）",
    outcome: "start",
    removalKept: true,
    children: [],
  };
  evidence.push(root);
  let nodeSeq = 1;
  let stepsUsed = 0;
  let exhausted = false;

  const candidates: Candidate[] = [
    ...Object.keys(current.env)
      .sort()
      .map((key) => ({ kind: "env" as const, key })),
    ...current.schedule.map((event, index) => ({
      kind: "schedule" as const,
      key: event,
      index,
    })),
  ];

  let parentId = root.id;
  for (const candidate of candidates) {
    if (stepsUsed >= budget) {
      exhausted = true;
      break;
    }
    // 调度事件删除后索引会移动，按当前配方重新定位
    let trial: Recipe;
    if (candidate.kind === "env") {
      if (!(candidate.key in current.env)) continue;
      trial = applyRemoval(current, candidate);
    } else {
      const idx = current.schedule.indexOf(candidate.key);
      if (idx === -1) continue;
      trial = applyRemoval(current, { ...candidate, index: idx });
    }
    const label =
      candidate.kind === "env"
        ? `删除环境变量 ${candidate.key}`
        : `删除调度事件 ${candidate.key}`;
    const result = await replayFn(trial);
    stepsUsed += 1;
    const kept = result.outcome === "reproduced";
    const node: EvidenceNode = {
      id: `e${nodeSeq++}`,
      parentId,
      action: label,
      outcome: result.outcome as ReplayOutcome,
      removalKept: kept,
      children: [],
    };
    evidence.push(node);
    evidence.find((n) => n.id === parentId)!.children.push(node.id);
    if (kept) {
      current = trial;
      parentId = node.id;
    }
  }

  return {
    recipeId: baseRecipe.id,
    recipe: current,
    evidence,
    stepsUsed,
    budget,
    exhausted,
    isGlobalMinimum: false,
  };
}
