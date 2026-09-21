import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseNdjson } from '../src/core/io.js';
import { buildClusterView } from '../src/core/clustering.js';

const fixturePath = fileURLToPath(new URL('./fixtures/example-runs.ndjson', import.meta.url));

describe('随项目提交的 NDJSON 夹具', () => {
  it('三行都能通过结构化校验', () => {
    const text = readFileSync(fixturePath, 'utf8');
    const parsed = parseNdjson(text);
    expect(parsed.issues).toEqual([]);
    expect(parsed.runs).toHaveLength(3);
    expect(parsed.runs[0].tempPathRoots).toContain('/tmp/pytest-of-import/ci-run-1');
  });

  it('前两条是近似但不同的失败（actual 不同），必须分成两个簇', () => {
    const parsed = parseNdjson(readFileSync(fixturePath, 'utf8'));
    const view = buildClusterView(parsed.runs.slice(0, 2), 2);
    const queueClusters = view.clusters.filter(
      (cluster) => cluster.testName === 'suite/queue-order-flake',
    );
    expect(queueClusters).toHaveLength(2);
  });
});
