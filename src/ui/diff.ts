export interface DiffLine {
  readonly type: 'same' | 'add' | 'del';
  readonly text: string;
}

/** 极简逐行 LCS 差异，用于“比较两条失败”。 */
export function lineDiff(a: string, b: string): DiffLine[] {
  const left = a.split('\n');
  const right = b.split('\n');
  const table: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i]![j] =
        left[i] === right[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      out.push({ type: 'same', text: left[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push({ type: 'del', text: left[i]! });
      i += 1;
    } else {
      out.push({ type: 'add', text: right[j]! });
      j += 1;
    }
  }
  while (i < left.length) {
    out.push({ type: 'del', text: left[i++]! });
  }
  while (j < right.length) {
    out.push({ type: 'add', text: right[j++]! });
  }
  return out;
}
