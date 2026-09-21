import type { RunRecord } from './types';

/**
 * 从原始运行提取“失败文本”。
 * 仅使用退出状态与 stdout 摘要中的失败区域，持续时间与临时路径
 * 由后续归一化阶段处理（并留下证据）。
 */
export function extractFailureText(run: RunRecord): string | null {
  if (run.exitStatus === 0) {
    return null;
  }
  const lines = run.stdoutSummary.split(/\r?\n/);
  const start = lines.findIndex((line) => /error|assert|fail|exception|timeout/i.test(line));
  const slice = start >= 0 ? lines.slice(start) : lines;
  return slice.join('\n').trim() || `exit=${run.exitStatus}`;
}

/** 失败行号（取自 first location 形式 file:line），行号不允许被噪声规则吞掉。 */
export function extractLocationLine(text: string): { file: string; line: number } | null {
  const match = text.match(/([\w./\\-]+\.[A-Za-z]{1,6}):(\d+)/);
  if (!match) {
    return null;
  }
  return { file: match[1]!, line: Number(match[2]) };
}
