import type {
  Recipe,
  ReplayResult,
  RunRecord,
} from "./types.js";
import {
  normalizeFailureOutput,
  CURRENT_RULE_VERSION,
  type NormalizationContext,
} from "./normalize.js";

export interface ExecutorManifest {
  name: string;
  version: number;
  supportedEnv: string[];
}

export type ExecuteFn = (recipe: Recipe) => Promise<RunRecord>;

export function checkEnvCompatibility(
  recipe: Recipe,
  manifest: ExecutorManifest,
): string[] {
  const supported = new Set(manifest.supportedEnv);
  return Object.keys(recipe.env).filter((k) => !supported.has(k));
}

export async function runReplay(
  recipe: Recipe,
  original: RunRecord,
  deps: {
    manifest: ExecutorManifest;
    execute: ExecuteFn;
    normCtx: NormalizationContext;
    ruleVersion?: number;
  },
): Promise<ReplayResult> {
  const version = deps.ruleVersion ?? CURRENT_RULE_VERSION;
  const missing = checkEnvCompatibility(recipe, deps.manifest);
  if (missing.length > 0) {
    return {
      outcome: "environment_incompatible",
      reason: `环境不兼容：执行器不支持的环境变量 ${missing.join(", ")}`,
    };
  }
  const replayed = await deps.execute(recipe);
  const originalNorm = normalizeFailureOutput(original.stdout, deps.normCtx, version);
  const replayedNorm = normalizeFailureOutput(replayed.stdout, deps.normCtx, version);
  if (originalNorm.signature === replayedNorm.signature) {
    return {
      outcome: "reproduced",
      reason: "重放后的失败签名与原始运行一致",
      replayedRun: replayed,
      replayedSignature: replayedNorm.signature,
    };
  }
  return {
    outcome: "not_reproduced",
    reason: "重放后的失败签名与原始运行不一致（未复现，不算通过）",
    replayedRun: replayed,
    replayedSignature: replayedNorm.signature,
  };
}
