/**
 * 确定性 64 位 FNV-1a 哈希，输出 16 字符十六进制。
 *
 * 刻意不依赖 Node 的 crypto：同一实现在浏览器、服务端与测试里结果一致，
 * 从而“运行指纹”在导入、导出、聚类成员引用之间保持稳定。
 */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

export function fnv1a64Hex(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i += 1) {
    // 按 UTF-16 码元逐字节处理（ASCII 主导的结构化记录足够稳定）。
    const code = input.charCodeAt(i);
    hash ^= BigInt(code & 0xff);
    hash = (hash * FNV_PRIME) & MASK64;
    hash ^= BigInt((code >> 8) & 0xff);
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash.toString(16).padStart(16, '0');
}
