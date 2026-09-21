import type { RunRecord } from './types';

import { canonicalStringify } from './canonical';

/**
 * 运行指纹：对原始运行的全部可观察内容取确定性哈希。
 * id 与 recordedAt 不参与指纹，避免“同内容不同编号”破坏去重。
 * 使用零依赖的 cyrb53，浏览器与服务端结果一致。
 */
export function runFingerprint(run: RunRecord): string {
  const material = {
    testName: run.testName,
    exitStatus: run.exitStatus,
    stdoutSummary: run.stdoutSummary,
    seed: run.seed,
    env: run.env,
    virtualTime: run.virtualTime,
    schedule: run.schedule,
    durationMs: run.durationMs,
    requirements: run.requirements,
  };
  return fallbackHash(canonicalStringify(material));
}

/** 兼容浏览器（无 node:crypto）的回退哈希，仅用于非持久化场景。 */
export function fallbackHash(input: string): string {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (
    'cyrb53:' +
    (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(13, '0')
  );
}
