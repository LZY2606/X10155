import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { emptyStore, exportNdjson, importNdjson, type StoreState } from "../core/store.js";
import type { MinimizerState, ReplayRecipe } from "../core/types.js";

export interface PersistedState {
  runs: StoreState;
  recipes: Record<string, ReplayRecipe>;
  minimizers: Record<string, MinimizerState>;
}

export function emptyPersisted(): PersistedState {
  return { runs: emptyStore(), recipes: {}, minimizers: {} };
}

/** JSON 文件持久化，写入用临时文件 + rename，避免半写状态。 */
export class JsonPersistence {
  private cache: PersistedState;
  private seedFrom?: string;

  constructor(private readonly filePath: string, seedFrom?: string) {
    this.seedFrom = seedFrom;
    this.cache = this.load();
  }

  private load(): PersistedState {
    if (!existsSync(this.filePath)) {
      const initial = emptyPersisted();
      if (this.seedFrom && existsSync(this.seedFrom)) {
        const report = importNdjson(initial.runs, readFileSync(this.seedFrom, "utf8"));
        initial.runs = report.state;
      }
      this.flush(initial);
      return initial;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<PersistedState>;
      return {
        runs: parsed.runs ?? emptyStore(),
        recipes: parsed.recipes ?? {},
        minimizers: parsed.minimizers ?? {},
      };
    } catch {
      // 持久化损坏不应拖垮服务：退回空库并要求重新导入。
      return emptyPersisted();
    }
  }

  private flush(state: PersistedState): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.filePath);
  }

  read(): PersistedState {
    return this.cache;
  }

  mutate(fn: (draft: PersistedState) => void): PersistedState {
    fn(this.cache);
    this.flush(this.cache);
    return this.cache;
  }

  /** 导出的运行 NDJSON 保持指纹与成员顺序。 */
  exportRunsNdjson(): string {
    return exportNdjson(this.cache.runs);
  }
}
