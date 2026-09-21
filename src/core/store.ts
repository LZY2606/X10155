import fs from 'node:fs';
import path from 'node:path';
import { fingerprintOf } from './hash.js';
import type { MinimizeState, ReplayRecipe, RunRecord, StoredRun } from './types.js';

interface StoreData {
  runs: StoredRun[];
  recipes: ReplayRecipe[];
  minimizers: MinimizeState[];
  nextSeq: number;
}

const RUN_FIELDS = [
  'testName',
  'exitStatus',
  'stdout',
  'seed',
  'env',
  'platform',
  'declaredTempPaths',
  'virtualTime',
  'schedule',
] as const;

export function validateRunRecord(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return '记录必须是对象';
  const r = raw as Record<string, unknown>;
  if (typeof r['testName'] !== 'string' || r['testName'] === '') return '缺少 testName';
  if (typeof r['exitStatus'] !== 'number') return 'exitStatus 必须是数字';
  if (typeof r['stdout'] !== 'string') return 'stdout 必须是字符串';
  if (typeof r['seed'] !== 'number') return 'seed 必须是数字';
  if (typeof r['env'] !== 'object' || r['env'] === null || Array.isArray(r['env']))
    return 'env 必须是对象';
  if (typeof r['platform'] !== 'string') return 'platform 必须是字符串';
  for (const f of ['declaredTempPaths', 'virtualTime', 'schedule'] as const) {
    if (!Array.isArray(r[f]) || !(r[f] as unknown[]).every((x) => typeof x === 'string'))
      return `${f} 必须是字符串数组`;
  }
  return null;
}

/** 文件持久化存储：运行、配方、最小化会话。 */
export class Store {
  private data: StoreData;
  constructor(private filePath: string) {
    this.data = { runs: [], recipes: [], minimizers: [], nextSeq: 1 };
    this.load();
  }

  private load() {
    try {
      const text = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(text) as StoreData;
      this.data = {
        runs: parsed.runs ?? [],
        recipes: parsed.recipes ?? [],
        minimizers: parsed.minimizers ?? [],
        nextSeq: parsed.nextSeq ?? (parsed.runs?.length ?? 0) + 1,
      };
    } catch {
      // 文件不存在或损坏：从空库开始
    }
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  listRuns(): StoredRun[] {
    return [...this.data.runs].sort((a, b) => a.seq - b.seq);
  }

  getRun(fingerprint: string): StoredRun | undefined {
    return this.data.runs.find((r) => r.fingerprint === fingerprint);
  }

  /**
   * 导入 NDJSON。每行一条运行记录；可携带 fingerprint（导出再导入时
   * 保留原指纹），指纹不匹配内容则拒绝该行。重复指纹跳过。
   */
  importNdjson(text: string): { imported: number; skipped: number; errors: string[] } {
    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    lines.forEach((line, i) => {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line);
      } catch {
        errors.push(`第 ${i + 1} 行: JSON 解析失败`);
        return;
      }
      const err = validateRunRecord(raw);
      if (err) {
        errors.push(`第 ${i + 1} 行: ${err}`);
        return;
      }
      const record: RunRecord = {
        testName: raw['testName'] as string,
        exitStatus: raw['exitStatus'] as number,
        stdout: raw['stdout'] as string,
        seed: raw['seed'] as number,
        env: raw['env'] as Record<string, string>,
        platform: raw['platform'] as string,
        declaredTempPaths: raw['declaredTempPaths'] as string[],
        virtualTime: raw['virtualTime'] as string[],
        schedule: raw['schedule'] as string[],
      };
      const computed = fingerprintOf(record);
      const claimed = typeof raw['fingerprint'] === 'string' ? (raw['fingerprint'] as string) : null;
      if (claimed && claimed !== computed) {
        errors.push(`第 ${i + 1} 行: 指纹与内容不匹配`);
        return;
      }
      if (this.data.runs.some((r) => r.fingerprint === computed)) {
        skipped += 1;
        return;
      }
      this.data.runs.push({
        ...record,
        fingerprint: computed,
        seq: this.data.nextSeq++,
        importedAt: new Date().toISOString(),
      });
      imported += 1;
    });
    if (imported > 0) this.persist();
    return { imported, skipped, errors };
  }

  /** 导出 NDJSON：保持指纹与导入顺序（聚类成员顺序由此派生）。 */
  exportNdjson(): string {
    return this.listRuns()
      .map((run) => {
        const out: Record<string, unknown> = { fingerprint: run.fingerprint };
        for (const f of RUN_FIELDS) out[f] = run[f];
        return JSON.stringify(out);
      })
      .join('\n');
  }

  listRecipes(): ReplayRecipe[] {
    return [...this.data.recipes];
  }

  getRecipe(id: string): ReplayRecipe | undefined {
    return this.data.recipes.find((r) => r.id === id);
  }

  saveRecipe(recipe: ReplayRecipe) {
    const idx = this.data.recipes.findIndex((r) => r.id === recipe.id);
    if (idx >= 0) this.data.recipes[idx] = recipe;
    else this.data.recipes.push(recipe);
    this.persist();
  }

  getMinimizer(recipeId: string): MinimizeState | undefined {
    return this.data.minimizers.find((m) => m.recipeId === recipeId);
  }

  saveMinimizer(state: MinimizeState) {
    const idx = this.data.minimizers.findIndex((m) => m.recipeId === state.recipeId);
    if (idx >= 0) this.data.minimizers[idx] = state;
    else this.data.minimizers.push(state);
    this.persist();
  }
}
