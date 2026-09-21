import { buildClusterView } from './clustering.js';
import { runFingerprint } from './fingerprint.js';
import { LATEST_RULESET_VERSION } from './normalizer.js';
import type {
  ClusterView,
  MinimizationState,
  ReplayRecipe,
  RunRecord,
  StoreState,
} from './types.js';

/**
 * 数据仓库：原始运行不可变；所有派生结构（聚类视图、配方、最小化实验）
 * 与运行一起持久化为单个 JSON 文件。
 */
export class Store {
  state: StoreState;

  constructor(initial?: StoreState) {
    this.state = initial ?? emptyState();
  }

  /**
   * 导入运行。返回导入的指纹（按输入顺序）。
   *  - 内容指纹已存在的运行跳过（幂等）；
   *  - 若记录附带 fingerprint 字段且与重算结果不一致，抛错（防篡改/防错配）。
   */
  importRuns(records: Array<RunRecord & { fingerprint?: string }>): string[] {
    const imported: string[] = [];
    for (const record of records) {
      const declared = record.fingerprint;
      const fingerprint = runFingerprint(record);
      if (declared !== undefined && declared.startsWith('run_') && declared !== fingerprint) {
        throw new Error(
          `运行指纹不一致：记录声明 ${declared}，按内容重算为 ${fingerprint}（拒绝导入，保证指纹可信）`,
        );
      }
      if (this.state.runs[fingerprint]) {
        continue;
      }
      const { fingerprint: _ignored, ...run } = record;
      void _ignored;
      this.state.runs[fingerprint] = run as RunRecord;
      this.state.runOrder.push(fingerprint);
      imported.push(fingerprint);
    }
    this.rebuildViews();
    return imported;
  }

  getRun(fingerprint: string): RunRecord | undefined {
    return this.state.runs[fingerprint];
  }

  listRuns(): Array<{ fingerprint: string; run: RunRecord }> {
    return this.state.runOrder.map((fingerprint) => ({
      fingerprint,
      run: this.state.runs[fingerprint],
    }));
  }

  clusterView(rulesetVersion: number): ClusterView {
    // 聚类视图永远从原始运行现算，保证规则版本语义稳定；缓存仅为避免重复计算。
    const view = buildClusterView(
      this.state.runOrder.map((fingerprint) => this.state.runs[fingerprint]),
      rulesetVersion,
    );
    this.state.clusterViews[rulesetVersion] = view;
    return view;
  }

  allClusterViews(): ClusterView[] {
    const versions = new Set<number>([1, LATEST_RULESET_VERSION]);
    return [...versions].map((version) => this.clusterView(version));
  }

  saveRecipe(recipe: ReplayRecipe): void {
    this.state.recipes[recipe.id] = recipe;
  }

  getRecipe(id: string): ReplayRecipe | undefined {
    return this.state.recipes[id];
  }

  listRecipes(): ReplayRecipe[] {
    return Object.values(this.state.recipes);
  }

  saveMinimization(minimization: MinimizationState): void {
    this.state.minimizations[minimization.id] = minimization;
  }

  getMinimization(id: string): MinimizationState | undefined {
    return this.state.minimizations[id];
  }

  rebuildViews(): void {
    for (const version of Object.keys(this.state.clusterViews).map(Number)) {
      this.state.clusterViews[version] = buildClusterView(
        this.state.runOrder.map((fingerprint) => this.state.runs[fingerprint]),
        version,
      );
    }
  }

  toJSON(): StoreState {
    return structuredClone(this.state);
  }

  static fromJSON(value: unknown): Store {
    const state = value as StoreState;
    if (
      !state ||
      typeof state !== 'object' ||
      !state.runs ||
      !Array.isArray(state.runOrder)
    ) {
      throw new Error('持久化文件结构不合法');
    }
    // 载入后校验指纹与顺序，防止手工篡改。
    for (const fingerprint of state.runOrder) {
      const run = state.runs[fingerprint];
      if (!run) {
        throw new Error(`持久化数据引用了缺失的运行 ${fingerprint}`);
      }
      if (runFingerprint(run) !== fingerprint) {
        throw new Error(`持久化数据中运行 ${fingerprint} 的指纹与内容不符`);
      }
    }
    return new Store(state);
  }
}

function emptyState(): StoreState {
  return {
    runs: {},
    runOrder: [],
    recipes: {},
    minimizations: {},
    clusterViews: {},
  };
}
