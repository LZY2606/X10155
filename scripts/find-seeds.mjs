// 开发工具：为内置假测试探测能触发失败分支的确定性种子。
// 用法（从仓库根目录）：
//   ../../node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild \
//     src/core/fakeExecutor.ts --bundle --platform=node --format=esm \
//     --outfile=/tmp/dist-probe/fakeExecutor.js
//   node scripts/find-seeds.mjs
import { executeFakeTest } from '/tmp/dist-probe/fakeExecutor.js';

function search(fakeTest, env, schedule = []) {
  for (let i = 1; i < 100000; i += 1) {
    const seed = `seed-${i}`;
    const { run } = executeFakeTest(fakeTest, seed, env, schedule);
    if (run.exitStatus !== 0) {
      const stderrLine = run.stderrSummary.split('\n').find((line) => /actual/.test(line)) ?? '';
      console.log(`${fakeTest}  seed=${seed}  exit=${run.exitStatus}  ${stderrLine.trim()}`);
      return seed;
    }
  }
  throw new Error(`no failing seed found for ${fakeTest}`);
}

search('suite/queue-order-flake', { REPLAY_MODE: 'replay' }, [
  { step: 0, point: 'queue', resource: 'job-queue', selected: 'consumer-B', waiters: ['consumer-A', 'consumer-B'] },
  { step: 1, point: 'queue', resource: 'job-queue', selected: 'consumer-B', waiters: ['consumer-A', 'consumer-B'] },
]);
search('suite/timeout-flake', { REPLAY_MODE: 'replay' });
search('suite/env-gated-flake', { REPLAY_MODE: 'replay', FLAKY_FEATURE_TOGGLE: 'on' });
