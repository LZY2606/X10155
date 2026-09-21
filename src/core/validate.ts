import path from "node:path";
import type { Recipe } from "./types.js";

export interface InvocationCheck {
  ok: boolean;
  reason: string;
}

const ALLOWED_FLAGS = new Set(["--recipe"]);

export function validateRecipeInvocation(
  recipe: Pick<Recipe, "executorPath" | "args">,
  allowedExecutorPath: string,
  allowedRecipeDir: string,
): InvocationCheck {
  const resolvedExecutor = path.resolve(recipe.executorPath);
  const resolvedAllowed = path.resolve(allowedExecutorPath);
  if (resolvedExecutor !== resolvedAllowed) {
    return {
      ok: false,
      reason: `执行器路径越界：${recipe.executorPath} 不是随项目提交的假执行器`,
    };
  }
  const resolvedRecipeDir = path.resolve(allowedRecipeDir);
  for (let i = 0; i < recipe.args.length; i += 1) {
    const arg = recipe.args[i];
    if (arg.startsWith("-")) {
      if (!ALLOWED_FLAGS.has(arg)) {
        return { ok: false, reason: `不允许的参数：${arg}` };
      }
      continue;
    }
    const resolved = path.resolve(arg);
    if (
      resolved !== resolvedRecipeDir &&
      !resolved.startsWith(resolvedRecipeDir + path.sep)
    ) {
      return { ok: false, reason: `参数路径越出允许目录：${arg}` };
    }
  }
  return { ok: true, reason: "" };
}
