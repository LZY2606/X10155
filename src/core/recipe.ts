import type { ReplayRecipe, TestRun } from "./types";

/**
 * Build a replay recipe from one run: seed, whitelisted environment and the
 * recorded scheduling decisions are pinned verbatim.
 */
export function recipeFromRun(run: TestRun): ReplayRecipe {
  return {
    id: `recipe-${run.id}`,
    sourceRunId: run.id,
    program: run.program,
    seed: run.seed,
    env: { ...run.envWhitelist },
    schedule: run.schedule.map((decision) => ({ ...decision })),
    args: [],
    tempRoots: [...(run.tempRoots ?? [])],
    createdAt: new Date(0).toISOString(),
  };
}

export function cloneRecipe(recipe: ReplayRecipe): ReplayRecipe {
  return {
    ...recipe,
    env: { ...recipe.env },
    schedule: recipe.schedule.map((decision) => ({ ...decision })),
    args: [...recipe.args],
    tempRoots: [...recipe.tempRoots],
  };
}
