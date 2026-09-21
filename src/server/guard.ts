import {
  ALLOWED_ACTOR_OPS,
  ALLOWED_VIRTUAL_KINDS,
  ENV_ALLOWLIST,
  EXECUTOR_VERSION,
  MAX_SCHEDULE_STEPS,
  REGISTERED_TESTS,
} from "../core/executor.js";
import type { ReplayRecipe, RuleVersion } from "../core/types.js";
import { RULE_VERSIONS } from "../core/normalize.js";

/**
 * 服务端边界：浏览器提交的任何配方都必须通过这里。
 * 配方只能描述“假执行器注册表内”的测试、环境键、路径根与调度动作，
 * 不能借路径或参数把执行引向 shell 或注册表之外。
 */
export interface GuardResult {
  ok: boolean;
  errors: string[];
}

const MAX_BODY_BYTES = 256 * 1024;
const MAX_ENV_ITEMS = 32;
const MAX_VIRTUAL_EVENTS = 64;
const MAX_STRING_LEN = 4096;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertBodySize(serializedLength: number): string | null {
  if (serializedLength > MAX_BODY_BYTES) return `请求体超过 ${MAX_BODY_BYTES} 字节上限`;
  return null;
}

export function guardRecipe(input: unknown, expectedExecutor = EXECUTOR_VERSION): GuardResult {
  const errors: string[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: ["配方必须是 JSON 对象"] };

  const testName = input.testName;
  if (typeof testName !== "string" || !(REGISTERED_TESTS as readonly string[]).includes(testName)) {
    errors.push(`testName 必须是执行器注册表中的测试：${[...REGISTERED_TESTS].join(", ")}`);
  }

  if (input.executorVersion !== expectedExecutor) {
    errors.push(`executorVersion 必须与随库执行器一致：${expectedExecutor}`);
  }

  if (typeof input.seed !== "number" || !Number.isInteger(input.seed)) {
    errors.push("seed 必须是整数");
  } else if (input.seed < 0 || input.seed > 2 ** 31 - 1) {
    errors.push("seed 超出允许范围");
  }

  // 环境：键与值都走白名单，WORKDIR 限制在沙箱根下，拒绝任何逃逸写法。
  if (input.env !== undefined && !isPlainObject(input.env)) {
    errors.push("env 必须是对象");
  } else if (isPlainObject(input.env)) {
    const entries = Object.entries(input.env);
    if (entries.length > MAX_ENV_ITEMS) errors.push("环境项数量超限");
    for (const [key, rawValue] of entries) {
      if (!(key in ENV_ALLOWLIST)) {
        errors.push(`环境键 ${key} 不在白名单内`);
        continue;
      }
      if (typeof rawValue !== "string") {
        errors.push(`环境值 ${key} 必须是字符串`);
        continue;
      }
      if (rawValue.length > MAX_STRING_LEN) {
        errors.push(`环境值 ${key} 过长`);
        continue;
      }
      if (key === "WORKDIR") {
        if (!rawValue.startsWith("/")) errors.push("WORKDIR 必须是绝对路径");
        if (rawValue.includes("\0") || rawValue.includes(".."))
          errors.push("WORKDIR 不允许出现 .. 或空字节");
        const roots = ENV_ALLOWLIST.WORKDIR.roots;
        if (!roots.some((root) => rawValue === root || rawValue.startsWith(root + "/")))
          errors.push(`WORKDIR 越出沙箱根：${roots.join(" / ")}`);
      }
      if (key === "ENABLE_FEATURE_X" && !["on", "off"].includes(rawValue))
        errors.push("ENABLE_FEATURE_X 只接受 on/off");
      if (key === "RETRY_COUNT" && !/^\d{1,3}$/.test(rawValue))
        errors.push("RETRY_COUNT 必须是小的非负整数");
      if (key === "TZ" && !/^(?:UTC|[A-Za-z_]+\/[A-Za-z_]+)$/.test(rawValue))
        errors.push("TZ 必须是受支持的时区令牌");
    }
  }

  // 调度：动作集合是封闭枚举，禁止任何“额外参数”字段（只允许 detail 文本）。
  if (!Array.isArray(input.schedule)) {
    errors.push("schedule 必须是数组");
  } else if (input.schedule.length > MAX_SCHEDULE_STEPS) {
    errors.push(`调度步骤超过 ${MAX_SCHEDULE_STEPS}`);
  } else {
    input.schedule.forEach((step: unknown, index: number) => {
      if (!isPlainObject(step)) {
        errors.push(`schedule[${index}] 不是对象`);
        return;
      }
      if (step.order !== index) errors.push(`schedule[${index}].order 必须从 0 连续编号`);
      if (typeof step.actor !== "string" || !(step.actor in ALLOWED_ACTOR_OPS))
        errors.push(`schedule[${index}].actor 未注册`);
      else if (
        typeof step.op !== "string" ||
        !ALLOWED_ACTOR_OPS[step.actor as keyof typeof ALLOWED_ACTOR_OPS]?.includes(step.op)
      )
        errors.push(`schedule[${index}].op 未注册`);
      const allowedKeys = new Set(["order", "actor", "op", "detail"]);
      for (const key of Object.keys(step)) {
        if (!allowedKeys.has(key)) errors.push(`schedule[${index}] 含越权字段 ${key}`);
      }
      if (step.detail !== undefined) {
        if (typeof step.detail !== "string" || step.detail.length > MAX_STRING_LEN)
          errors.push(`schedule[${index}].detail 非法`);
      }
    });
  }

  // 虚拟时间：封闭的事件类型集合，atMs 非负数，不允许携带路径/命令字段。
  if (!Array.isArray(input.virtualTime)) {
    errors.push("virtualTime 必须是数组");
  } else if (input.virtualTime.length > MAX_VIRTUAL_EVENTS) {
    errors.push(`虚拟时间事件超过 ${MAX_VIRTUAL_EVENTS}`);
  } else {
    input.virtualTime.forEach((event: unknown, index: number) => {
      if (!isPlainObject(event)) {
        errors.push(`virtualTime[${index}] 不是对象`);
        return;
      }
      if (typeof event.atMs !== "number" || event.atMs < 0 || !Number.isFinite(event.atMs))
        errors.push(`virtualTime[${index}].atMs 必须是非负有限数`);
      if (
        typeof event.kind !== "string" ||
        !ALLOWED_VIRTUAL_KINDS.includes(event.kind as (typeof ALLOWED_VIRTUAL_KINDS)[number])
      )
        errors.push(`virtualTime[${index}].kind 未注册`);
      const allowedKeys = new Set(["atMs", "kind", "detail"]);
      for (const key of Object.keys(event)) {
        if (!allowedKeys.has(key)) errors.push(`virtualTime[${index}] 含越权字段 ${key}`);
      }
      if (event.detail !== undefined) {
        if (typeof event.detail !== "string" || event.detail.length > MAX_STRING_LEN)
          errors.push(`virtualTime[${index}].detail 非法`);
      }
    });
  }

  if (input.expected !== undefined) {
    if (!isPlainObject(input.expected)) errors.push("expected 必须是对象");
    else {
      for (const [version, hash] of Object.entries(input.expected)) {
        if (!RULE_VERSIONS.includes(version as RuleVersion))
          errors.push(`expected 含未知规则版本 ${version}`);
        if (typeof hash !== "string") errors.push(`expected.${version} 必须是字符串`);
      }
    }
  }

  if (input.derivedFromFingerprint !== undefined && typeof input.derivedFromFingerprint !== "string")
    errors.push("derivedFromFingerprint 必须是字符串");
  if (input.note !== undefined && typeof input.note !== "string")
    errors.push("note 必须是字符串");

  return { ok: errors.length === 0, errors };
}

/** 服务端不信任客户端的 id/executorVersion：按受信内容重建配方。 */
export function sanitizeRecipe(
  input: Record<string, unknown>,
  derivedFromFingerprint: string,
  buildId: (body: Omit<ReplayRecipe, "id">) => ReplayRecipe,
): ReplayRecipe {
  const body: Omit<ReplayRecipe, "id"> = {
    derivedFromFingerprint,
    testName: input.testName as string,
    executorVersion: EXECUTOR_VERSION,
    seed: input.seed as number,
    env: { ...(input.env as Record<string, string>) },
    schedule: (input.schedule as ReplayRecipe["schedule"]).map((step) => ({
      order: step.order,
      actor: step.actor,
      op: step.op,
      ...(step.detail !== undefined ? { detail: step.detail } : {}),
    })),
    virtualTime: (input.virtualTime as ReplayRecipe["virtualTime"]).map((event) => ({
      atMs: event.atMs,
      kind: event.kind,
      ...(event.detail !== undefined ? { detail: event.detail } : {}),
    })),
    expected: { ...(input.expected as ReplayRecipe["expected"]) },
    ...(typeof input.note === "string" ? { note: input.note } : {}),
  };
  return buildId(body);
}
