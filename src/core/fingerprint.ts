import { canonicalJson } from './canonical.js';
import { fnv1a64Hex } from './hash.js';
import type { RunRecord } from './types.js';

export const FINGERPRINT_SCHEME = 'run-fp-v1';

/** 计算原始运行的稳定指纹：只依赖运行内容，与导入时间、来源无关。 */
export function runFingerprint(run: RunRecord): string {
  const { fingerprint: _declared, ...content } = run as RunRecord & {
    fingerprint?: string;
  };
  void _declared;
  return `run_${fnv1a64Hex(canonicalJson({ scheme: FINGERPRINT_SCHEME, run: content }))}`;
}
