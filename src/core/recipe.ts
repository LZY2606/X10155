import { buildSignature, RULE_VERSIONS, stableHash } from "./normalize.js";
import { EXECUTOR_VERSION, executeRecipe } from "./executor.js";
import type {
  ReplayOutcome,
  ReplayRecipe,
  ReplayResult,
  RunRecord,
  ScheduleStep,
  StoredRun,
  VirtualTimeEvent,
} from "./types.js";

function canonicalRecipeBody(recipe: Omit<ReplayRecipe, "id">): string {
  return JSON.stringify({
    derivedFromFingerprint: recipe.derivedFromFingerprint,
    testName: recipe.testName,
    executorVersion: recipe.executorVersion,
    seed: recipe.seed,
    env: Object.keys(recipe.env)
      .sort()
      .map((key) => [key, recipe.env[key]]),
    schedule: recipe.schedule,
    virtualTime: recipe.virtualTime,
    expected: recipe.expected,
    note: recipe.note ?? null,
  });
}

/** 从一条（失败）运行建立重放配方：固定种子、环境白名单、调度与虚拟时间。 */
export function recipeFromRun(
  run: Pick<
    StoredRun,
    "fingerprint" | "testName" | "seed" | "env" | "schedule" | "virtualTime"
  >,
): ReplayRecipe {
  const body: Omit<ReplayRecipe, "id"> = {
    derivedFromFingerprint: run.fingerprint,
    testName: run.testName,
    executorVersion: EXECUTOR_VERSION,
    seed: run.seed ?? 0,
    env: { ...(run.env ?? {}) },
    schedule: (run.schedule ?? []).map((step) => ({ ...step })),
    virtualTime: (run.virtualTime ?? []).map((event) => ({ ...event })),
    expected: {},
  };
  return withRecipeId(body);
}

/** 编辑后的克隆：内容变化必然得到新的确定性 id，旧配方不被覆盖。 */
export function withRecipeId(body: Omit<ReplayRecipe, "id">): ReplayRecipe {
  return { ...body, id: `recipe-${stableHash(canonicalRecipeBody(body)).slice(0, 16)}` };
}

export function editRecipe(
  recipe: ReplayRecipe,
  patch: {
    seed?: number;
    env?: Record<string, string>;
    schedule?: ScheduleStep[];
    virtualTime?: VirtualTimeEvent[];
    note?: string;
  },
): ReplayRecipe {
  const { id: _omit, ...body } = recipe;
  return withRecipeId({
    ...body,
    seed: patch.seed ?? body.seed,
    env: patch.env ? { ...patch.env } : body.env,
    schedule: patch.schedule ? patch.schedule.map((step) => ({ ...step })) : body.schedule,
    virtualTime: patch.virtualTime
      ? patch.virtualTime.map((event) => ({ ...event }))
      : body.virtualTime,
    note: patch.note !== undefined ? patch.note : body.note,
  });
}

/** 把执行器输出还原成一个“运行记录”形态，以便用同一套签名规则比较。 */
export function runRecordFromResult(recipe: ReplayRecipe, result: ReplayResult): RunRecord {
  const tempPathPrefixes = Object.values(recipe.env).filter((value) => value.startsWith("/"));
  return {
    testName: recipe.testName,
    status: result.exitStatus,
    exitCode: result.exitCode,
    stdoutSummary: result.stdoutSummary,
    stderrSummary: result.stderrSummary,
    seed: recipe.seed,
    env: recipe.env,
    tempPathPrefixes,
    durationMs: result.durationMs,
    virtualTime: result.virtualTime,
    schedule: result.schedule,
  };
}

/**
 * 重放并判定三态：
 *  - reproduced：执行器失败签名命中配方期望
 *  - not-reproduced：能跑但签名不符（含通过）——不能算通过意义上的复现
 *  - environment-incompatible：执行器明确拒绝该环境
 */
export function replayRecipe(recipe: ReplayRecipe): ReplayResult {
  const raw = executeRecipe(recipe);
  if (raw.outcome === "environment-incompatible") return raw;

  const synthRun = runRecordFromResult(recipe, raw);
  let outcome: ReplayOutcome = "not-reproduced";
  let matchedSignature: string | undefined;
  for (const version of RULE_VERSIONS) {
    const expected = recipe.expected[version];
    if (!expected) continue;
    const actual = buildSignature(synthRun, version).signatureHash;
    if (actual === expected) {
      outcome = "reproduced";
      matchedSignature = expected;
      break;
    }
  }
  return { ...raw, outcome, matchedSignature };
}

/** 为配方补全所有规则版本下的期望签名（通常在建立配方时使用）。 */
export function withExpectedSignatures(
  recipe: ReplayRecipe,
  sourceRun: RunRecord,
): ReplayRecipe {
  const { id: _omit, ...body } = recipe;
  const expected: ReplayRecipe["expected"] = {};
  for (const version of RULE_VERSIONS) {
    expected[version] = buildSignature(sourceRun, version).signatureHash;
  }
  return withRecipeId({ ...body, expected });
}
