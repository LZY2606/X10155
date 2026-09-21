/**
 * 确定性假执行器声明的宿主能力。提交进项目、永不读取真实机器状态，
 * 因此演示与测试结果可重放。
 */
export const EXECUTOR_CAPABILITIES = {
  platform: 'linux',
  runtimeVersion: '22.11.0',
  caps: ['clock:virtual', 'scheduler:scripted', 'fs:sandbox'],
} as const;

export interface EnvironmentRequirements {
  platform: string;
  runtimeVersion: string;
  caps: readonly string[];
}

/**
 * 逐条返回不兼容原因；空数组表示兼容。
 * 平台与运行时版本做精确匹配，能力要求必须是宿主能力的子集。
 */
export function checkCompatibility(
  requirements: EnvironmentRequirements,
): string[] {
  const reasons: string[] = [];
  if (requirements.platform !== EXECUTOR_CAPABILITIES.platform) {
    reasons.push(
      `平台不兼容：测试需要 ${requirements.platform}，执行器仅提供 ${EXECUTOR_CAPABILITIES.platform}`,
    );
  }
  if (requirements.runtimeVersion !== EXECUTOR_CAPABILITIES.runtimeVersion) {
    reasons.push(
      `运行时版本不兼容：测试需要 ${requirements.runtimeVersion}，执行器固定为 ${EXECUTOR_CAPABILITIES.runtimeVersion}`,
    );
  }
  for (const cap of requirements.caps) {
    if (!EXECUTOR_CAPABILITIES.caps.includes(cap as (typeof EXECUTOR_CAPABILITIES.caps)[number])) {
      reasons.push(`执行器缺少能力：${cap}`);
    }
  }
  return reasons;
}
