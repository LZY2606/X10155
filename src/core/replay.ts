import type {
  FailureSignature,
  ReplayRecipe,
  ReplayResult,
} from "./types";
import { failureSignature } from "./normalize";
import type { TestRun } from "./types";
import { execute, recipeToRequest } from "../executor/executor";

/**
 * Replay a recipe and classify the outcome:
 *  - reproduced: same exit/error signature as the target run
 *  - not-reproduced: ran fine in this environment, but failure did not recur
 *  - env-incompatible: environment rejected / unsupported; cannot be "passed"
 *
 * Only "reproduced" is a positive match. The other two are explicitly
 * non-passing terminal outcomes.
 */
export function replayRecipe(
  recipe: ReplayRecipe,
  target: Pick<TestRun, "stdoutSummary" | "errorType" | "exitCode" | "testName"> &
    Partial<Pick<TestRun, "tempRoots">>,
): ReplayResult {
  const targetSig: FailureSignature = failureSignature(
    {
      ...target,
      exitStatus: target.exitCode === 0 ? "passed" : "failed",
      program: recipe.program,
      seed: recipe.seed,
      envWhitelist: recipe.env,
      virtualTimeEvents: [],
      schedule: recipe.schedule,
      importedAt: "",
      fingerprint: "",
      id: "",
    } as TestRun,
    "v1",
  );

  const exec = execute(recipeToRequest(recipe));
  if (!exec.compatible) {
    return {
      outcome: "env-incompatible",
      exitStatus: exec.exitStatus,
      exitCode: exec.exitCode,
      stdoutSummary: exec.stdoutSummary,
      matchedSignature: false,
      reason: exec.incompatibilityReason,
    };
  }

  const replayedSig = failureSignature(
    {
      testName: target.testName,
      program: recipe.program,
      exitStatus: exec.exitStatus,
      exitCode: exec.exitCode,
      errorType: exec.errorType,
      stdoutSummary: exec.stdoutSummary,
      seed: recipe.seed,
      envWhitelist: recipe.env,
      virtualTimeEvents: exec.virtualTimeEvents,
      schedule: recipe.schedule,
      tempRoots: recipe.tempRoots,
      importedAt: "",
      fingerprint: "",
      id: "",
    } as TestRun,
    "v1",
  );

  const matched =
    exec.exitStatus !== "passed" && replayedSig.signature === targetSig.signature;

  if (matched) {
    return {
      outcome: "reproduced",
      exitStatus: exec.exitStatus,
      exitCode: exec.exitCode,
      stdoutSummary: exec.stdoutSummary,
      errorType: exec.errorType,
      matchedSignature: true,
    };
  }

  return {
    outcome: "not-reproduced",
    exitStatus: exec.exitStatus,
    exitCode: exec.exitCode,
    stdoutSummary: exec.stdoutSummary,
    errorType: exec.errorType,
    matchedSignature: false,
    reason:
      exec.exitStatus === "passed"
        ? "本次运行通过，失败未复现"
        : "产生了失败但签名与目标不一致（近似但不同的失败）",
  };
}
