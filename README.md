# 不稳定测试重放库（Flaky Test Replay Library）

把偶发失败变成**可重放的本地实验**：导入测试命令的结构化运行记录，按失败签名聚类，
从单条运行固定种子 / 环境 / 调度决策生成重放配方，并在严格预算下逐步最小化，每一步都留证据。

重放只允许命中**随项目提交的确定性假执行器**——浏览器与任何 API 都无法让服务端执行
任意用户命令，也无法借路径或参数越出执行器沙箱。

## 安装与演示

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm test -- --run
pnpm dev -- --host 127.0.0.1 --port 5231
```

打开 <http://127.0.0.1:5231>，页面标题为 **“不稳定测试重放库”**。首次启动会自动播种
一批确定性演示数据（见 `src/server/seed.ts`），全部由假执行器或带噪声的历史运行组成。

## 数据模型（`src/core/types.ts`）

- `RunRecord`：结构化运行——测试名、退出状态、stdout/stderr 摘要、随机种子、
  环境白名单、虚拟时间事件、并发调度轨迹、可选结构化错误（错误类型 / 文件:行:列 / 断言期望与实际）。
  原始运行**不可变**，指纹是内容的 FNV-1a 64 位哈希（`run_<16hex>`）。
- `FailureSignature`：在某个**版本化规则集**下对失败形态的哈希，附带规范载荷与归一化证据。
- `ClusterView`：某规则集版本的聚类视图；簇成员是运行指纹，顺序等于首次导入顺序。
- `ReplayRecipe`：固定假测试 id、种子、环境子集、调度决策序列、期望失败签名与退出状态。
- `MinimizationState`：最小化实验，含逐步证据、已用重放数、预算与终止状态。

## 归一化规则与版本（`src/core/normalizer.ts`）

规则是纯函数、幂等、可解释，每条规则记录 `introducedIn` 版本与文字说明：

- **v1**
  - `temp-paths-v1`：使用者声明的临时路径根 + 常见系统临时目录（`/tmp/...`、
    `/var/folders/.../T/...`、`%TEMP%`）→ `<TMP>`，只替换目录前缀，保留相对路径与 `:行号:列号`。
  - `duration-noise-v1`：计时语境（took/elapsed/duration/timeout/deadline 等）与
    非断言行上的耗时数字 → `<DUR>`。
- **v2** 新增 `wallclock-iso8601-v2`：ISO-8601 挂钟时间戳 → `<TIME>`。

纪律：**行号、错误类型、断言期望/实际值永不归一化**；通用耗时规则不作用于
含 `assert/expect/expected/actual` 的断言行，也不匹配 `:42` 形式的行号。

新规则只会生成新的聚类视图；v1 视图从不被改写（测试 `test/clustering.test.ts` 覆盖）。

## 聚类与比较

- 仅失败运行（`exitStatus !== 0`）参与聚类；签名载荷刻意排除 `startedAt` / `durationMs`
  与调度决策本身（调度是“如何触发”，不是“失败形态”）。
- 浏览器中可在 v1 / v2 视图间切换，查看每个簇命中了哪些规则、命中次数与替换证据，
  并对任意两条运行做行级 diff（行号 / 断言值的真实变化会直接显示）。

## 重放三态（`src/core/fakeExecutor.ts`）

`replayRecipe` 只可能返回：

- `reproduced`：观测失败签名与期望一致（唯一表示“重现了来源失败”）；
- `not-reproduced`：运行通过或失败形态变了——**不算通过**；
- `env-incompatible`：缺少/不支持 `REPLAY_MODE`、坏数字环境值等——**也不算通过**。

假执行器内置三个确定性测试：并发队列顺序反转、虚拟时间超时、环境开关分支。
`(testId, seed, env, schedule) → RunRecord` 是纯函数，相同输入逐字节相同。

### 服务端安全边界（`validateRecipeRequest`）

- 测试 id 必须在固定枚举 `FAKE_TESTS` 中；未知测试 / “外部命令”一律拒绝（400/422）。
- 环境键必须在该测试的白名单内；值不得含 NUL、换行、shell 元字符（`; & | \` $ < > ( ) { } \\`）或 `..`。
- 路径类环境变量（如 `FLAKY_TMPDIR`）必须解析在项目内 `data/sandbox/` 之下；
  `/etc/...`、`../../` 等路径逃逸返回 422。
- 调度决策只能引用该测试真实存在的调度点与执行体。

## 最小化（`src/core/minimizer.ts`）

- 逐步删减：每一步尝试删除**一个**环境项（非必需项优先）或**一条**尾部调度事件，
  并做恰好一次重放；仍然 `reproduced` 才接受，否则回滚。
- 每个 `MinimizationStep` 保存尝试时的完整配方快照、结论与累计重放数，形成证据树。
- 预算按重放次数计；耗尽时状态为 `budget-exhausted` 并返回**当前最小**结果，
  绝不声称全局最小。候选全部试过则为 `fixed-point`（相对于该删减操作集的局部最小）。

## 持久化与导入导出

- 状态持久化在服务端 `data/store.json`（原子写；已被 gitignore，首次启动自动播种）。
- NDJSON 导入：非法行整批拒绝并报告行号；内容指纹幂等去重；
  导出的每条记录附带 `fingerprint`，重新导入时会与重算指纹比对，篡改即拒绝。
- 导出顺序与聚类成员顺序都等于 `runOrder`（首次导入顺序），重建视图结果稳定。

## API 一览（`src/server/api.ts`，Vite 中间件挂载于 `/api`）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/state` | 运行、规则、各版本聚类视图、配方、最小化实验 |
| POST | `/api/import` | 导入 NDJSON（整批校验） |
| GET | `/api/export` | 导出带指纹的 NDJSON |
| POST | `/api/recipes` | 从一条运行建立配方 |
| PUT | `/api/recipes/:id` | 编辑种子 / 环境 / 调度（重新过边界校验，内容寻址生成新 id） |
| POST | `/api/recipes/:id/replay` | 执行重放，返回三态结果 |
| POST | `/api/recipes/:id/minimize` | 初始化 / 继续逐步最小化（预算、步数、continueId） |
| POST | `/api/compare` | 比较两条运行在指定规则版本下的签名 |

## 代码结构

```
src/core/           纯领域逻辑（无 DOM / HTTP 依赖）
  types.ts          领域类型
  hash.ts           确定性 FNV-1a 64
  normalizer.ts     版本化归一化规则
  signature.ts      失败签名
  clustering.ts     聚类视图（纯函数重建）
  fakeExecutor.ts   确定性假测试 + 安全边界校验 + 重放
  recipe.ts         从运行建立配方
  minimizer.ts      有预算、有证据的逐步最小化
  io.ts             NDJSON 解析/校验/导出
  store.ts          原始运行/配方/视图仓库（指纹校验）
src/server/         api.ts（框架无关处理器）、persistence.ts、seed.ts
src/ui/             React 单页（导入/聚类/比较/配方/最小化证据树/原始运行）
test/               Vitest：噪声规则、规则版本、近似失败、环境兼容、
                    预算中止、路径逃逸、稳定聚类、持久化与 API 边界
vite.config.ts      开发服务器 + /api 中间件（不经过 shell）
```
