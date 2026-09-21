import path from 'node:path';
import { canonicalJson, sha256 } from './hash.js';
import type { ReplayRecipe } from './types.js';

/**
 * 确定性假测试执行器。
 *
 * 安全模型：浏览器/服务端永远不执行任意用户命令。配方里的 command
 * 必须解析到随项目提交的 executor/ 目录内的 fake-test.mjs，参数只
 * 允许 `--test <name>` 白名单形式。服务端在执行前强制校验，任何
 * 路径逃逸（..、绝对路径、符号链接到目录外）都会被拒绝。
 */

export const EXECUTOR_DIR_NAME = 'executor';
export const FAKE_TEST_BIN = 'fake-test.mjs';
export const ALLOWED_ARGS_PATTERN = /^--test$/;
export const TEST_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

/** 宿主环境能力：重放配方的环境白名单必须与之兼容。 */
export const HOST_CAPABILITIES = {
  platform: 'fake-os/arm64',
  envKeys: ['TMPDIR', 'CI', 'TZ', 'LOCALE', 'FEATURE_FLAG'],
} as const;

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export function executorDir(rootDir: string): string {
  return path.resolve(rootDir, EXECUTOR_DIR_NAME);
}

export function fakeTestBinPath(rootDir: string): string {
  return path.join(executorDir(rootDir), FAKE_TEST_BIN);
}

/** 校验配方命令与参数，拒绝任何越出假执行器的路径或参数。 */
export function validateRecipeCommand(
  command: string,
  args: string[],
  rootDir: string,
): ValidationResult {
  if (typeof command !== 'string' || command.length === 0) {
    return { ok: false, reason: 'command 不能为空' };
  }
  const resolved = path.resolve(rootDir, command);
  const allowedDir = executorDir(rootDir);
  const rel = path.relative(allowedDir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, reason: `命令路径越出执行器目录: ${command}` };
  }
  if (resolved !== fakeTestBinPath(rootDir)) {
    return { ok: false, reason: `命令不是受信的假测试执行器: ${command}` };
  }
  if (!Array.isArray(args)) {
    return { ok: false, reason: 'args 必须是数组' };
  }
  if (args.length !== 0) {
    if (args.length !== 2 || !ALLOWED_ARGS_PATTERN.test(args[0] ?? '')) {
      return { ok: false, reason: `参数不在白名单内: ${JSON.stringify(args)}` };
    }
    if (!TEST_NAME_PATTERN.test(args[1] ?? '')) {
      return { ok: false, reason: `非法测试名参数: ${args[1]}` };
    }
  }
  return { ok: true };
}

export interface ExecutionResult {
  exitStatus: number;
  stdout: string;
}

function pick(hex: string, offset: number, mod: number): number {
  return parseInt(hex.slice(offset, offset + 8), 16) % mod;
}

/**
 * 确定性执行：结果完全由 (testName, seed, env, virtualTime, schedule)
 * 决定。同一配方永远得到同一结果 —— 这就是“可重放的本地实验”。
 */
export function executeFakeTest(
  recipe: Pick<ReplayRecipe, 'seed' | 'env' | 'virtualTime' | 'schedule'> & { testName: string },
): ExecutionResult {
  const key = sha256(
    canonicalJson({
      testName: recipe.testName,
      seed: recipe.seed,
      env: recipe.env,
      virtualTime: recipe.virtualTime,
      schedule: recipe.schedule,
    }),
  );
  const fails = pick(key, 0, 3) === 0;
  const expected = pick(key, 8, 90) + 1;
  const actual = pick(key, 16, 90) + 1;
  const line = pick(key, 24, 400) + 1;
  const durationMs = pick(key, 32, 900) + 50;
  const tmp = recipe.env['TMPDIR'] ?? '/tmp/fake-executor';
  const lines: string[] = [];
  if (fails) {
    lines.push(`FAIL ${recipe.testName}`);
    lines.push(`AssertionError: expected ${expected} to be ${actual}`);
    lines.push(`    at runCase (src/${recipe.testName}.spec.ts:${line}:11)`);
    lines.push(`    at worker (node:internal/test_runner:88:3)`);
    lines.push(`scratch dir: ${tmp}/scratch-${recipe.seed}`);
    lines.push(`Completed in ${durationMs}ms`);
    return { exitStatus: 1, stdout: lines.join('\n') };
  }
  lines.push(`PASS ${recipe.testName}`);
  lines.push(`scratch dir: ${tmp}/scratch-${recipe.seed}`);
  lines.push(`Completed in ${durationMs}ms`);
  return { exitStatus: 0, stdout: lines.join('\n') };
}
