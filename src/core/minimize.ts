import { replayRecipe } from './replay';
import type {
  EvidenceNode,
  MinimizeSession,
  NoisePolicy,
  ReplayRecipe,
  ReplayResult,
  ScheduleEvent,
} from './types';

const DEFAULT_BUDGET = 24;

interface MutableNode {
  nodeId: string;
  step: number;
  kind: EvidenceNode['kind'];
  description: string;
  removedKeys: string[];
  replay: ReplayResult;
  children: MutableNode[];
}

export interface MinimizeInternals {
  phase: 'env' | 'schedule' | 'done';
  envKeys: string[];
  envCursor: number;
  scheduleKeys: number[];
  scheduleCursor: number;
  root: MutableNode;
  currentParent: MutableNode;
}

export interface InternalMinimizeSession extends MinimizeSession {
  currentRecipe: ReplayRecipe;
  step: number;
  evidence: EvidenceNode;
  internals: MinimizeInternals;
}

function nodeFrom(mutable: MutableNode): EvidenceNode {
  return {
    ...mutable,
    children: mutable.children.map(nodeFrom),
  };
}

function snapshot(session: InternalMinimizeSession): void {
  session.evidence = nodeFrom(session.internals.root);
}

/** 建立最小化会话：先做基线重放；基线无法复现则不进入删减。 */
export function createMinimizeSession(
  recipe: ReplayRecipe,
  policy: NoisePolicy,
  budget: number = DEFAULT_BUDGET,
): InternalMinimizeSession {
  if (!Number.isInteger(budget) || budget < 1) {
    throw new Error('预算必须是正整数');
  }
  const baseline = replayRecipe(recipe, policy);
  const root: MutableNode = {
    nodeId: 'baseline',
    step: 0,
    kind: 'baseline',
    description: '基线配方重放（未做任何删减）',
    removedKeys: [],
    replay: baseline,
    children: [],
  };

  let status: InternalMinimizeSession['status'] = 'reproducing';
  if (baseline.outcome === 'environment-incompatible') {
    status = 'environment-incompatible';
  } else if (baseline.outcome !== 'reproduced') {
    status = 'could-not-reproduce';
  }

  const session: InternalMinimizeSession = {
    sessionId: `minimize:${recipe.id}`,
    recipeId: recipe.id,
    status,
    budget,
    replaysUsed: 1,
    currentRecipe: recipe,
    step: 0,
    evidence: nodeFrom(root),
    internals: {
      phase: status === 'reproducing' ? 'env' : 'done',
      envKeys: Object.keys(recipe.env).sort(),
      envCursor: 0,
      scheduleKeys: recipe.schedule.map((event) => event.seq).sort((a, b) => a - b),
      scheduleCursor: 0,
      root,
      currentParent: root,
    },
  };
  return session;
}

function withoutEnv(recipe: ReplayRecipe, key: string): ReplayRecipe {
  const env: Record<string, string> = {};
  for (const [envKey, value] of Object.entries(recipe.env)) {
    if (envKey !== key) {
      env[envKey] = value;
    }
  }
  return { ...recipe, env };
}

function withoutScheduleSeq(
  recipe: ReplayRecipe,
  seq: number,
): ReplayRecipe {
  return {
    ...recipe,
    schedule: recipe.schedule
      .filter((event) => event.seq !== seq)
      .map((event: ScheduleEvent) => ({ ...event })),
  };
}

function nextAttempt(
  session: InternalMinimizeSession,
): { kind: 'env' | 'schedule'; key: string | number } | null {
  const internals = session.internals;
  if (internals.phase === 'env') {
    if (internals.envCursor < internals.envKeys.length) {
      const key = internals.envKeys[internals.envCursor]!;
      return { kind: 'env', key };
    }
    internals.phase = 'schedule';
  }
  if (internals.phase === 'schedule') {
    if (internals.scheduleCursor < internals.scheduleKeys.length) {
      const key = internals.scheduleKeys[internals.scheduleCursor]!;
      return { kind: 'schedule', key };
    }
    internals.phase = 'done';
  }
  return null;
}

/**
 * 执行一步删减并重放。返回更新后的会话；当没有更多步骤时幂等返回。
 * 每一步都把重放证据挂到证据树上；预算耗尽立即停止并保留当前最小结果，
 * 绝不宣称全局最小。
 */
export function stepMinimizeSession(
  session: InternalMinimizeSession,
  policy: NoisePolicy,
): InternalMinimizeSession {
  if (
    session.status === 'minimized' ||
    session.status === 'budget-exhausted' ||
    session.status === 'could-not-reproduce' ||
    session.status === 'environment-incompatible'
  ) {
    return session;
  }

  const attempt = nextAttempt(session);
  if (attempt === null) {
    session.status = 'minimized';
    snapshot(session);
    return session;
  }

  if (session.replaysUsed >= session.budget) {
    session.status = 'budget-exhausted';
    snapshot(session);
    return session;
  }

  session.step += 1;
  const step = session.step;
  const removedKeys = [`${attempt.kind}:${String(attempt.key)}`];
  const candidate =
    attempt.kind === 'env'
      ? withoutEnv(session.currentRecipe, attempt.key as string)
      : withoutScheduleSeq(session.currentRecipe, attempt.key as number);

  const result = replayRecipe(candidate, policy);
  session.replaysUsed += 1;

  const accepted = result.outcome === 'reproduced';
  const node: MutableNode = {
    nodeId: `step-${step}`,
    step,
    kind: accepted
      ? attempt.kind === 'env'
        ? 'remove-env'
        : 'remove-schedule'
      : 'rejected',
    description:
      attempt.kind === 'env'
        ? accepted
          ? `删除环境变量 ${String(attempt.key)} 后仍复现 → 接受删减`
          : `删除环境变量 ${String(attempt.key)} 后不再复现/不兼容 → 保留该项`
        : accepted
          ? `删除调度事件 seq=${String(attempt.key)} 后仍复现 → 接受删减`
          : `删除调度事件 seq=${String(attempt.key)} 后不再复现/不兼容 → 保留该事件`,
    removedKeys,
    replay: result,
    children: [],
  };

  if (accepted) {
    session.currentRecipe = candidate;
    session.internals.currentParent.children.push(node);
    session.internals.currentParent = node;
  } else {
    session.internals.currentParent.children.push(node);
  }

  if (attempt.kind === 'env') {
    session.internals.envCursor += 1;
  } else {
    session.internals.scheduleCursor += 1;
  }

  if (session.replaysUsed >= session.budget) {
    session.status = 'budget-exhausted';
  }
  snapshot(session);
  return session;
}

/** 跑到结束或预算耗尽（供测试使用）。 */
export function runMinimizeToEnd(
  recipe: ReplayRecipe,
  policy: NoisePolicy,
  budget: number = DEFAULT_BUDGET,
): InternalMinimizeSession {
  let session = createMinimizeSession(recipe, policy, budget);
  let guard = 0;
  while (session.status === 'reproducing' && guard < 10000) {
    session = stepMinimizeSession(session, policy);
    guard += 1;
  }
  return session;
}
