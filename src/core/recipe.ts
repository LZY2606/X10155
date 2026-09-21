import { signatureForRun } from './normalize';
import type {
  NoisePolicy,
  ReplayRecipe,
  RunRecord,
  ScheduleEvent,
} from './types';

/** 执行器允许的环境变量白名单；配方中的键必须是其子集。 */
export const ENV_ALLOWLIST = [
  'WORKER_COUNT',
  'LOG_LEVEL',
  'TMPDIR_ROOT',
  'NETWORK_MODE',
] as const;

export class RecipeValidationError extends Error {}

function assertStringRecord(value: unknown, where: string): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RecipeValidationError(`${where} 必须是对象`);
  }
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val !== 'string') {
      throw new RecipeValidationError(`${where}.${key} 必须是字符串`);
    }
    out[key] = val;
  }
  return out;
}

const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;
const ENV_VALUE_PATTERN = /^[A-Za-z0-9._:/=-]{0,128}$/;
/** 路径类环境值：绝对路径，禁止 .. 段、禁止反斜杠/空字节，长度受限。 */
const SAFE_PATH_PATTERN = /^\/(?:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)?$/;

export function validateEnvMap(
  env: Record<string, string>,
): void {
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new RecipeValidationError(`非法环境变量名：${key}`);
    }
    if (!(ENV_ALLOWLIST as readonly string[]).includes(key)) {
      throw new RecipeValidationError(`环境变量不在执行器白名单内：${key}`);
    }
    if (value.includes('\0')) {
      throw new RecipeValidationError(`环境变量 ${key} 含空字节`);
    }
    if (key === 'TMPDIR_ROOT') {
      if (value.length > 0 && !SAFE_PATH_PATTERN.test(value)) {
        throw new RecipeValidationError(
          `TMPDIR_ROOT 必须是不含 .. 的简单绝对路径，拒绝路径逃逸：${value}`,
        );
      }
    } else if (!ENV_VALUE_PATTERN.test(value)) {
      throw new RecipeValidationError(`环境变量 ${key} 的值越出允许字符集：${value}`);
    }
  }
}

function validateSchedule(schedule: unknown): ScheduleEvent[] {
  if (!Array.isArray(schedule)) {
    throw new RecipeValidationError('schedule 必须是数组');
  }
  if (schedule.length > 256) {
    throw new RecipeValidationError('schedule 事件数量超过 256');
  }
  return schedule.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new RecipeValidationError(`schedule[${index}] 必须是对象`);
    }
    const event = raw as Record<string, unknown>;
    for (const field of ['seq', 'atMs', 'actor', 'action', 'resource']) {
      if (!(field in event)) {
        throw new RecipeValidationError(`schedule[${index}] 缺少字段 ${field}`);
      }
    }
    if (typeof event.seq !== 'number' || !Number.isInteger(event.seq) || event.seq < 0) {
      throw new RecipeValidationError(`schedule[${index}].seq 必须是非负整数`);
    }
    if (typeof event.atMs !== 'number' || !Number.isFinite(event.atMs) || event.atMs < 0) {
      throw new RecipeValidationError(`schedule[${index}].atMs 必须是非负有限数`);
    }
    for (const field of ['actor', 'action', 'resource'] as const) {
      if (typeof event[field] !== 'string' || !/^[A-Za-z0-9._:-]{1,48}$/.test(event[field] as string)) {
        throw new RecipeValidationError(`schedule[${index}].${field} 含非法字符`);
      }
    }
    return {
      seq: event.seq,
      atMs: event.atMs,
      actor: event.actor as string,
      action: event.action as string,
      resource: event.resource as string,
    };
  });
}

/**
 * 严格校验来自浏览器的配方：
 * - 拒绝未知顶层字段（防止夹带任意命令/路径参数）；
 * - testId 必须命中注册的假测试（见 executor）；
 * - 环境键必须在白名单，路径值不得逃逸；
 * - 调度字段全部走字符白名单。
 */
export function validateRecipeShape(input: unknown): {
  testId: string;
  seed: number;
  env: Record<string, string>;
  schedule: ScheduleEvent[];
} {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new RecipeValidationError('配方必须是对象');
  }
  const obj = input as Record<string, unknown>;
  const allowed = new Set(['testId', 'seed', 'env', 'schedule']);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new RecipeValidationError(`配方含非法顶层字段：${key}`);
    }
  }
  if (typeof obj.testId !== 'string' || !/^[a-z0-9][a-z0-9:-]{0,63}$/i.test(obj.testId)) {
    throw new RecipeValidationError(`非法 testId：${String(obj.testId)}`);
  }
  if (
    typeof obj.seed !== 'number' ||
    !Number.isInteger(obj.seed) ||
    obj.seed < 0 ||
    obj.seed > 0xffffffff
  ) {
    throw new RecipeValidationError('seed 必须是 0..2^32-1 的整数');
  }
  const env = assertStringRecord(obj.env ?? {}, 'env');
  validateEnvMap(env);
  const schedule = validateSchedule(obj.schedule ?? []);
  return { testId: obj.testId, seed: obj.seed, env, schedule };
}

function deriveTestId(testName: string): string {
  return testName.split(' > ')[0]!.trim();
}

/** 从一条失败运行建立重放配方：固定种子、环境白名单与调度决策。 */
export function buildRecipe(
  run: RunRecord,
  policy: NoisePolicy,
): ReplayRecipe {
  if (run.exitStatus === 0) {
    throw new Error('只能从失败运行建立重放配方');
  }
  const failure = signatureForRun(run, policy);
  if (!failure) {
    throw new Error('无法从该运行计算失败签名');
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(run.env)) {
    if ((ENV_ALLOWLIST as readonly string[]).includes(key)) {
      env[key] = value;
    }
  }
  return {
    recipeVersion: 1,
    id: `recipe:${run.id}`,
    sourceRunId: run.id,
    testId: deriveTestId(run.testName),
    seed: run.seed,
    env,
    schedule: run.schedule.map((event) => ({ ...event })),
    targetSignature: failure.signature,
    targetPackId: policy.packId,
    targetPackVersion: policy.packVersion,
    createdAt: run.recordedAt,
  };
}

/** 应用一次编辑后的字段（编辑结果同样经过严格校验，由服务端执行）。 */
export function withRecipeEdits(
  recipe: ReplayRecipe,
  edits: { seed?: number; env?: Record<string, string>; schedule?: ScheduleEvent[] },
): ReplayRecipe {
  return {
    ...recipe,
    seed: edits.seed ?? recipe.seed,
    env: edits.env ? { ...edits.env } : { ...recipe.env },
    schedule: edits.schedule
      ? edits.schedule.map((event) => ({ ...event }))
      : recipe.schedule.map((event) => ({ ...event })),
  };
}
