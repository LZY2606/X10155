import type {
  ReplayRecipe,
  ScheduleDecision,
  TestRun,
  VirtualTimeEvent,
} from "../core/types";
import { guardRecipe } from "./guard";

/**
 * Deterministic fake test executor. It never spawns a process and never calls
 * a shell: every "program" is a pure function of (seed, env, schedule).
 * Shipped with the project so the browser demo needs no user commands.
 */

export const KNOWN_PROGRAMS = new Set([
  "flaky-timer",
  "data-race",
  "env-sens",
]);

export const ALLOWED_ENV_KEYS = new Set([
  "TIMER_MODE",
  "RUN_ID",
  "TMPDIR",
  "REQUIRED_SDK",
]);

export interface ExecResult {
  exitStatus: TestRun["exitStatus"];
  exitCode: number;
  errorType?: string;
  stdoutSummary: string;
  virtualTimeEvents: VirtualTimeEvent[];
}

export interface ExecRequest {
  program: string;
  seed: string;
  env: Record<string, string>;
  schedule: ScheduleDecision[];
  args: string[];
  tempRoots: string[];
}

export interface ExecResponse extends ExecResult {
  /** When false, the recipe is incompatible and no test semantics ran. */
  compatible: boolean;
  incompatibilityReason?: string;
}

export function execute(request: ExecRequest): ExecResponse {
  const guard = guardRecipe({
    knownPrograms: KNOWN_PROGRAMS,
    program: request.program,
    args: request.args,
    env: request.env,
    allowedEnvKeys: ALLOWED_ENV_KEYS,
  });
  if (!guard.ok) {
    return {
      compatible: false,
      incompatibilityReason: guard.reason,
      exitStatus: "errored",
      exitCode: 126,
      stdoutSummary: `[executor] rejected: ${guard.reason}`,
      virtualTimeEvents: [],
    };
  }

  const rng = mulberry32(
    hashSeed(request.seed + "|" + stableString(request.env)),
  );
  switch (request.program) {
    case "flaky-timer":
      return runFlakyTimer(request, rng);
    case "data-race":
      return runDataRace(request, rng);
    case "env-sens":
      return runEnvSens(request, rng);
    default:
      return unreachableProgram(request.program);
  }
}

function runFlakyTimer(req: ExecRequest, rng: () => number): ExecResponse {
  if (req.env.TIMER_MODE === undefined) {
    return incompatible("缺少必需环境变量 TIMER_MODE（v1/v2 仿真器要求）");
  }
  if (req.env.TIMER_MODE !== "virtual" && req.env.TIMER_MODE !== "wall") {
    return incompatible(
      `TIMER_MODE="${req.env.TIMER_MODE}" 不被支持（仅 virtual/wall）`,
    );
  }

  // Only wake decisions contend for the timer thread; passive observer
  // events ("observe"/"signal") are recorded but cannot shift firing jitter.
  const contended = req.schedule.filter(
    (decision) => decision.kind === "wake" || decision.kind === "yield" || decision.kind === "lock-acquire",
  );
  const scheduleBias = scheduleHash(contended) % 7;
  const jitterMs = Math.floor(rng() * 6) + scheduleBias;
  const deadline = 4;
  const firedAt = 3 + jitterMs;
  const tmp = req.env.TMPDIR ?? "/tmp";
  const runId = req.env.RUN_ID ?? "run";
  const events: VirtualTimeEvent[] = [
    { atMs: 0, kind: "timer-arm", detail: "deadline=4ms" },
    ...req.schedule
      .filter((decision) => decision.kind === "observe")
      .map((decision, index) => ({
        atMs: 1 + index,
        kind: "observe" as const,
        detail: decision.actor,
      })),
    { atMs: firedAt, kind: "timer-fire", detail: `jitter=${jitterMs}` },
    {
      atMs: firedAt + 1,
      kind: "log",
      detail: `${tmp}/timer-${runId}.log`,
    },
  ];
  // The trace printed to users references a stable artifact name; the
  // ephemeral TMPDIR/RUN_ID path only exists in virtual-time events, so it is
  // genuinely irrelevant to the failure signature.
  void tmp;
  void runId;

  if (firedAt > deadline) {
    return {
      compatible: true,
      exitStatus: "timeout",
      exitCode: 124,
      errorType: "TimeoutError",
      stdoutSummary:
        `TimeoutError: timer deadline exceeded at timer_test.ts:42\n` +
        `  expected fire by ${deadline}ms, actual fire at ${firedAt}ms (took ${firedAt}ms)\n` +
        `  trace timer-trace.log 0x${Math.floor(rng() * 0xffff)
          .toString(16)
          .padStart(4, "0")}`,
      virtualTimeEvents: events,
    };
  }
  return {
    compatible: true,
    exitStatus: "passed",
    exitCode: 0,
    stdoutSummary: `ok - timer fired at ${firedAt}ms (took ${firedAt}ms)`,
    virtualTimeEvents: events,
  };
}

function runDataRace(req: ExecRequest, rng: () => number): ExecResponse {
  // The pinned schedule decides actor interleaving. Two distinct real failure
  // shapes exist: line 42 vs line 58, with different assertion values.
  const wakeOrder = req.schedule
    .filter((decision) => decision.kind === "wake")
    .map((decision) => decision.actor);
  const first = wakeOrder[0] ?? (rng() < 0.5 ? "worker-0" : "worker-1");
  const events: VirtualTimeEvent[] = [
    { atMs: 0, kind: "spawn", detail: "worker-0,worker-1" },
    { atMs: 2, kind: "wake", detail: first },
  ];

  if (first === "worker-1") {
    return {
      compatible: true,
      exitStatus: "failed",
      exitCode: 1,
      errorType: "AssertionError",
      stdoutSummary:
        `AssertionError: counter mismatch at race_test.ts:42\n` +
        `  expected 1, got 2 (stale read by worker-1)\n` +
        `  elapsed ${Math.floor(rng() * 9000 + 1000)}us`,
      virtualTimeEvents: events,
    };
  }

  const bias = scheduleHash(req.schedule) % 5 === 0;
  if (bias) {
    return {
      compatible: true,
      exitStatus: "failed",
      exitCode: 1,
      errorType: "AssertionError",
      stdoutSummary:
        `AssertionError: counter mismatch at race_test.ts:58\n` +
        `  expected 3, got 7 (merge order inverted)\n` +
        `  elapsed ${Math.floor(rng() * 9000 + 1000)}us`,
      virtualTimeEvents: [...events, { atMs: 5, kind: "merge", detail: "inverted" }],
    };
  }

  return {
    compatible: true,
    exitStatus: "passed",
    exitCode: 0,
    stdoutSummary: "ok - counter consistent",
    virtualTimeEvents: events,
  };
}

function runEnvSens(req: ExecRequest, _rng: () => number): ExecResponse {
  const sdk = req.env.REQUIRED_SDK;
  if (sdk === undefined) {
    return incompatible("缺少必需环境变量 REQUIRED_SDK");
  }
  if (!/^\d+\.\d+$/.test(sdk)) {
    return incompatible(`REQUIRED_SDK="${sdk}" 不是受支持的 x.y 版本`);
  }
  const [major, minor] = sdk.split(".").map(Number);
  const tmp = req.env.TMPDIR ?? "/tmp";
  if (major < 2 || (major === 2 && minor < 3)) {
    return {
      compatible: true,
      exitStatus: "errored",
      exitCode: 2,
      errorType: "EnvironmentError",
      stdoutSummary:
        `EnvironmentError: sdk ${sdk} lacks ReplayAPI at env_test.ts:17\n` +
        `  artifact ${tmp}/sdk-${sdk}.bin`,
      virtualTimeEvents: [
        { atMs: 0, kind: "sdk-check", detail: sdk },
      ],
    };
  }
  return {
    compatible: true,
    exitStatus: "passed",
    exitCode: 0,
    stdoutSummary: `ok - sdk ${sdk} supports ReplayAPI`,
    virtualTimeEvents: [{ atMs: 0, kind: "sdk-check", detail: sdk }],
  };
}

function incompatible(reason: string): ExecResponse {
  return {
    compatible: false,
    incompatibilityReason: reason,
    exitStatus: "errored",
    exitCode: 125,
    stdoutSummary: `[incompatible] ${reason}`,
    virtualTimeEvents: [],
  };
}

function unreachableProgram(program: string): ExecResponse {
  return {
    compatible: false,
    incompatibilityReason: `未知程序 ${program}`,
    exitStatus: "errored",
    exitCode: 126,
    stdoutSummary: "",
    virtualTimeEvents: [],
  };
}

export function recipeToRequest(recipe: ReplayRecipe): ExecRequest {
  return {
    program: recipe.program,
    seed: recipe.seed,
    env: recipe.env,
    schedule: recipe.schedule,
    args: recipe.args,
    tempRoots: recipe.tempRoots,
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function scheduleHash(schedule: ScheduleDecision[]): number {
  let hash = 0;
  for (const decision of schedule) {
    hash =
      (hash * 31 +
        hashSeed(`${decision.actor}:${decision.kind}:${decision.chosen}`)) >>> 0;
  }
  return hash;
}

function stableString(value: Record<string, string>): string {
  return Object.keys(value)
    .sort()
    .map((key) => `${key}=${value[key]}`)
    .join("&");
}
