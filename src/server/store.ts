import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mergeRuns, parseNDJSON } from '../core/ndjson';
import { buildRecipe } from '../core/recipe';
import type {
  ImportReport,
  NoisePolicy,
  ReplayRecipe,
  RunRecord,
} from '../core/types';

const DEFAULT_POLICY: NoisePolicy = {
  // macOS 演示环境的临时目录根；路径噪声只在声明的根之下被忽略。
  tempRoots: ['/private/tmp', '/tmp'],
  packId: 'builtin',
  policyVersion: 1,
};

interface PersistedState {
  runs: RunRecord[];
  recipes: ReplayRecipe[];
  noisePolicy: NoisePolicy;
  activePackVersion: number;
}

/**
 * 服务端持久化：JSON 文件落盘，重启不丢数据。
 * 浏览器永远接触不到文件路径本身——它只能通过受限 API 操作数据。
 */
export class VaultStore {
  private readonly file: string;
  private runs: RunRecord[] = [];
  private recipes: ReplayRecipe[] = [];
  private noisePolicy: NoisePolicy = DEFAULT_POLICY;
  private activePackVersion = 1;

  constructor(dataDir: string) {
    this.file = resolve(dataDir, 'state.json');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) {
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as PersistedState;
      this.runs = Array.isArray(parsed.runs) ? parsed.runs : [];
      this.recipes = Array.isArray(parsed.recipes) ? parsed.recipes : [];
      this.noisePolicy = parsed.noisePolicy ?? DEFAULT_POLICY;
      this.activePackVersion = parsed.activePackVersion ?? 1;
    } catch {
      // 损坏的持久化文件不应让服务起不来；退化为空库。
      this.runs = [];
      this.recipes = [];
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const payload: PersistedState = {
      runs: this.runs,
      recipes: this.recipes,
      noisePolicy: this.noisePolicy,
      activePackVersion: this.activePackVersion,
    };
    writeFileSync(this.file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  snapshot(): PersistedState {
    return {
      runs: this.runs,
      recipes: this.recipes,
      noisePolicy: this.noisePolicy,
      activePackVersion: this.activePackVersion,
    };
  }

  importNDJSON(text: string): ImportReport {
    const { runs: incoming, report } = parseNDJSON(text);
    const merged = mergeRuns(this.runs, incoming);
    this.runs = merged.runs;
    this.persist();
    return {
      imported: merged.imported,
      skippedDuplicates: merged.skippedDuplicates,
      errors: report.errors,
      fingerprintConflicts: merged.conflicts,
    };
  }

  setPolicy(patch: {
    tempRoots?: readonly string[];
    packVersion?: number;
  }): NoisePolicy {
    if (patch.tempRoots !== undefined) {
      const roots = patch.tempRoots.map((root) => String(root).trim()).filter(Boolean);
      for (const root of roots) {
        if (root.includes('\0') || root.length > 256) {
          throw new Error('临时路径根非法');
        }
      }
      // 用户改变临时路径声明 → 新的策略版本；旧配方记录其生成时版本。
      const changed =
        roots.length !== this.noisePolicy.tempRoots.length ||
        roots.some((root, index) => root !== this.noisePolicy.tempRoots[index]);
      this.noisePolicy = {
        ...this.noisePolicy,
        tempRoots: roots,
        policyVersion: changed
          ? this.noisePolicy.policyVersion + 1
          : this.noisePolicy.policyVersion,
      };
    }
    if (patch.packVersion !== undefined) {
      this.activePackVersion = patch.packVersion;
    }
    this.persist();
    return this.activePolicy();
  }

  activePolicy(): NoisePolicy {
    return { ...this.noisePolicy, packVersion: this.activePackVersion };
  }

  policyForPack(packVersion: number): NoisePolicy {
    return { ...this.noisePolicy, packVersion: packVersion };
  }

  createRecipe(runId: string): ReplayRecipe {
    const run = this.runs.find((entry) => entry.id === runId);
    if (!run) {
      throw new Error(`找不到运行：${runId}`);
    }
    const recipe = buildRecipe(run, this.activePolicy());
    const others = this.recipes.filter((entry) => entry.id !== recipe.id);
    this.recipes = [...others, recipe];
    this.persist();
    return recipe;
  }

  getRecipe(recipeId: string): ReplayRecipe | undefined {
    return this.recipes.find((entry) => entry.id === recipeId);
  }

  putRecipe(recipe: ReplayRecipe): void {
    const others = this.recipes.filter((entry) => entry.id !== recipe.id);
    this.recipes = [...others, recipe];
    this.persist();
  }

  reset(): void {
    this.runs = [];
    this.recipes = [];
    this.noisePolicy = DEFAULT_POLICY;
    this.activePackVersion = 1;
    this.persist();
  }

  loadSample(runs: readonly RunRecord[]): ImportReport {
    const merged = mergeRuns(this.runs, runs);
    this.runs = merged.runs;
    this.persist();
    return {
      imported: merged.imported,
      skippedDuplicates: merged.skippedDuplicates,
      errors: [],
      fingerprintConflicts: merged.conflicts,
    };
  }
}
