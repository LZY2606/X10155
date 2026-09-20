import { isAbsolute, resolve, sep } from "node:path";

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

/**
 * Recipes may only drive the in-process deterministic fake executor. Nothing
 * here ever reaches a shell. This guard rejects attempts to smuggle paths or
 * parameters outside the executor's declared surface.
 */
export function guardRecipe(input: {
  knownPrograms: ReadonlySet<string>;
  program: string;
  args: string[];
  env: Record<string, string>;
  allowedEnvKeys: ReadonlySet<string>;
}): GuardResult {
  if (!input.knownPrograms.has(input.program)) {
    return {
      ok: false,
      reason: `未知执行器程序 "${input.program}"，拒绝执行（只允许内置假执行器）`,
    };
  }

  if (input.args.length > 0) {
    return {
      ok: false,
      reason: `程序 "${input.program}" 不接受额外参数，拒绝 ${input.args.length} 个参数`,
    };
  }

  for (const key of Object.keys(input.env)) {
    if (!input.allowedEnvKeys.has(key)) {
      return {
        ok: false,
        reason: `环境变量 "${key}" 不在执行器白名单内，疑似越权`,
      };
    }
  }

  for (const [key, value] of Object.entries(input.env)) {
    const pathCheck = checkEnvPathValue(key, value);
    if (!pathCheck.ok) return pathCheck;
  }

  return { ok: true };
}

function checkEnvPathValue(key: string, value: string): GuardResult {
  if (value.includes("\0")) {
    return { ok: false, reason: `环境变量 "${key}" 含 NUL 字节` };
  }
  // Only variables explicitly named as paths may carry path-like values.
  const isPathKey = /DIR|PATH|ROOT$/.test(key);
  if (!isPathKey) return { ok: true };

  const resolved = resolve(value);
  if (value.includes("..")) {
    return { ok: false, reason: `路径变量 "${key}" 含 ".."，禁止路径逃逸` };
  }
  if (!isAbsolute(resolved)) {
    return { ok: false, reason: `路径变量 "${key}" 必须是绝对路径` };
  }

  // Confine to a temporary workspace root: /tmp, /private/tmp, /var/folders
  // or a per-user TMPDIR shape. System dirs are explicitly off-limits.
  const allowedPrefixes = [
    `${sep}tmp${sep}`,
    `${sep}private${sep}tmp${sep}`,
    `${sep}var${sep}folders${sep}`,
  ];
  const allowed =
    resolved === sep + "tmp" ||
    allowedPrefixes.some((prefix) => resolved.startsWith(prefix));
  if (!allowed) {
    return {
      ok: false,
      reason: `路径变量 "${key}" 指向临时工作区之外：${resolved}`,
    };
  }
  return { ok: true };
}
