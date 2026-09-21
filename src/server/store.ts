import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type {
  ClusterView,
  MinimizeResult,
  Recipe,
  StoredRun,
} from "../core/types.js";

export interface Settings {
  tempPaths: string[];
}

export interface StoreData {
  runs: StoredRun[];
  recipes: Recipe[];
  views: Record<string, ClusterView>;
  minimizations: Record<string, MinimizeResult>;
  settings: Settings;
}

const DEFAULT_DATA: StoreData = {
  runs: [],
  recipes: [],
  views: {},
  minimizations: {},
  settings: { tempPaths: ["/tmp/flaky-", "/var/folders/"] },
};

export class Store {
  readonly file: string;
  data: StoreData;

  constructor(file: string) {
    this.file = file;
    this.data = structuredClone(DEFAULT_DATA);
    this.load();
  }

  load(): void {
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, "utf8"));
        this.data = { ...structuredClone(DEFAULT_DATA), ...parsed };
      } catch {
        this.data = structuredClone(DEFAULT_DATA);
      }
    }
  }

  save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  reset(): void {
    this.data = structuredClone(DEFAULT_DATA);
    this.save();
  }
}
