/**
 * 规范 JSON 序列化：对象键递归排序，保证等价载荷逐字节相同。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(stringify(value));
}

function stringify(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stringify);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, stringify(v)]));
  }
  return value;
}
