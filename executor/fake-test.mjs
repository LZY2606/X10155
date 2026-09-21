#!/usr/bin/env node
/**
 * 确定性假测试执行器（随项目提交）。
 *
 * 这是演示用的“被测二进制”：服务端通过 src/core/executor.ts 中的
 * 纯函数复刻同一确定性逻辑，浏览器永远不能直接让服务端执行任意
 * 命令。本脚本也可独立运行，便于手工核对：
 *   node executor/fake-test.mjs --test demo.case
 */
console.log('fake-test: 请通过重放库服务端运行（确定性逻辑见 src/core/executor.ts）');
