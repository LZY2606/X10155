/**
 * 确定性 JSON 序列化：对象键排序、无多余空白。
 * 用于运行指纹与失败签名，保证跨进程、跨机器可重放。
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (
      typeof value === 'number' &&
      (Number.isNaN(value) || !Number.isFinite(value))
    ) {
      throw new TypeError('无法规范化 NaN/Infinity');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = canonicalize(record[key]);
  }
  return out;
}
