# 不稳定测试重放库（Flaky Test Replay Library）

把偶发失败变成**可重放的本地实验**，而不是只统计失败次数。

- 导入测试命令的**结构化运行记录**：测试名、退出状态、stdout 摘要、随机种子、
  环境白名单、虚拟时间事件、并发调度轨迹（NDJSON，每行一条）。
- 按**失败签名**聚类；原始运行始终原样保留。每个聚类都能解释用了哪些归一化规则、
  每条规则命中多少次。
- 归一化规则**有版本**：`v1` 折叠声明的临时路径、耗时、系统 tmp 形态、十六进制地址；
  `v2` 额外折叠 pid/UUID。新规则只生成**新的聚类视图**，旧视图永不被改写。
- 签名只忽略噪声，**不会吞掉**行号（`foo_test.ts:42`）、错误类型（`AssertionError`）
  或断言值（`expected 1, got 2`）的真实变化。
- 从一条运行建立**重放配方**：固定种子、环境、调度决策。结果只有
  `reproduced` / `not-reproduced` / `env-incompatible`；后两者**明确不算通过**。
- **逐步最小化**：每一步删减一个环境项或调度事件并重放，接受/拒绝都保留证据；
  预算耗尽立即停止并返回当前最小结果，`globalMinimumClaimed` 始终为 `false`，
  绝不伪称全局最小。
- 浏览器支持：导入 NDJSON、查看聚类、比较两条失败（token 级 diff）、编辑配方、
  逐步最小化并浏览证据树。
- 随项目提交的**确定性假执行器**（`src/executor`）是进程内纯函数，**没有 shell、
  不 spawn 任何进程**；服务端守卫拒绝未知程序、额外参数、非白名单环境变量、
  路径穿越（`..`）与逃逸出临时工作区的路径。
- 数据持久化到 `.data/flaky-store.json`；导入/导出保持运行指纹与聚类成员顺序。

## 安装与运行

```bash
corepack enable
pnpm install --frozen-lockfile

pnpm test -- --run
pnpm dev -- --host 127.0.0.1 --port 5231
```

打开 <http://127.0.0.1:5231> 即可看到「不稳定测试重放库」。首次启动会自动导入
`sample-data/runs.ndjson` 中的示例运行（由 `scripts/gen-samples.ts` 用假执行器
确定性生成）。

## 目录结构

- `src/core` — 指纹、版本化归一化规则、签名聚类、配方、重放分类、最小化、diff。
- `src/executor` — 确定性假执行器与路径/参数守卫（无 shell）。
- `src/server` — Vite 中间件 API 与 JSON 文件持久化。
- `src/ui` — React 单页界面。
- `sample-data/runs.ndjson` — 随项目提交的示例运行。
- `test` — 噪声规则、规则版本、近似但不同的失败、环境兼容、预算中止、路径逃逸、
  稳定聚类，以及端到端 HTTP 流程。

## API 摘要

- `GET /api/state?version=v1|v2` — 运行 + 该版本聚类视图 + 配方/会话。
- `POST /api/import` — 导入 NDJSON（校验或重算指纹）。
- `GET /api/export` — 导出保序、带指纹的 NDJSON。
- `POST /api/compare` — 两条失败的归一化 diff。
- `POST /api/recipes`、`PUT /api/recipes/:id`、`POST /api/recipes/:id/replay`。
- `POST /api/recipes/:id/minimize`、`POST /api/minimize/:id/step`。
- `POST /api/rule-version`、`POST /api/reset`。
