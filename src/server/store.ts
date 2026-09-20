import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  MinimizeSession,
  ReplayRecipe,
  RuleVersion,
  TestRun,
} from "../core/types";
import { runFingerprint, verifyFingerprint } from "../core/fingerprint";

export interface StoreData {
  runs: TestRun[];
  recipes: ReplayRecipe[];
  sessions: MinimizeSession[];
  ruleVersions: RuleVersion[];
  activeRuleVersion: RuleVersion;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
  runs: TestRun[];
}

export class Store {
  private readonly path: string;
  private data: StoreData;

  constructor(path: string, seed?: () => StoreData) {
    this.path = path;
    if (existsSync(path)) {
      this.data = JSON.parse(readFileSync(path, "utf8")) as StoreData;
    } else {
      this.data = seed
        ? seed()
        : {
            runs: [],
            recipes: [],
            sessions: [],
            ruleVersions: ["v1", "v2"],
            activeRuleVersion: "v1",
          };
      this.persist();
    }
  }

  snapshot(): StoreData {
    return JSON.parse(JSON.stringify(this.data)) as StoreData;
  }

  getRuns(): TestRun[] {
    return this.snapshot().runs;
  }

  getRun(id: string): TestRun | undefined {
    return this.data.runs.find((run) => run.id === id);
  }

  getRecipes(): ReplayRecipe[] {
    return this.snapshot().recipes;
  }

  getRecipe(id: string): ReplayRecipe | undefined {
    return this.data.recipes.find((recipe) => recipe.id === id);
  }

  saveRecipe(recipe: ReplayRecipe): void {
    const index = this.data.recipes.findIndex((item) => item.id === recipe.id);
    if (index >= 0) this.data.recipes[index] = recipe;
    else this.data.recipes.push(recipe);
    this.persist();
  }

  deleteRecipe(id: string): void {
    this.data.recipes = this.data.recipes.filter((recipe) => recipe.id !== id);
    this.persist();
  }

  getSession(id: string): MinimizeSession | undefined {
    return this.data.sessions.find((session) => session.id === id);
  }

  saveSession(session: MinimizeSession): void {
    const index = this.data.sessions.findIndex((item) => item.id === session.id);
    if (index >= 0) this.data.sessions[index] = session;
    else this.data.sessions.push(session);
    this.persist();
  }

  getActiveRuleVersion(): RuleVersion {
    return this.data.activeRuleVersion;
  }

  setActiveRuleVersion(version: RuleVersion): void {
    this.data.activeRuleVersion = version;
    this.persist();
  }

  /**
   * Import raw parsed run records. Existing fingerprints are verified; a bad
   * fingerprint rejects the line rather than silently mutating history.
   * Duplicate fingerprints are skipped (still counted) so re-importing an
   * export keeps cluster membership order identical.
   */
  importRecords(
    records: unknown[],
    options: { now: () => Date; recomputeFingerprint?: boolean },
  ): ImportResult {
    const errors: string[] = [];
    let imported = 0;
    let skipped = 0;
    const accepted: TestRun[] = [];
    const known = new Set(this.data.runs.map((run) => run.fingerprint));

    records.forEach((raw, line) => {
      const parsed = parseRecord(raw, line, errors, options.recomputeFingerprint);
      if (!parsed) return;
      if (known.has(parsed.fingerprint)) {
        skipped++;
        return;
      }
      known.add(parsed.fingerprint);
      this.data.runs.push(parsed);
      accepted.push(parsed);
      imported++;
    });

    if (imported > 0) this.persist();
    return { imported, skipped, errors, runs: accepted };
  }

  /** Runs serialized in import order; fingerprints embedded verbatim. */
  exportNdjson(): string {
    return this.data.runs.map((run) => JSON.stringify(run)).join("\n") + "\n";
  }

  reset(fresh: StoreData): void {
    this.data = fresh;
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}

type RawRun = Omit<TestRun, "id" | "importedAt" | "fingerprint"> &
  Partial<Pick<TestRun, "id" | "importedAt" | "fingerprint">>;

function parseRecord(
  raw: unknown,
  line: number,
  errors: string[],
  recompute: boolean | undefined,
): TestRun | null {
  if (typeof raw !== "object" || raw === null) {
    errors.push(`第 ${line + 1} 行：不是 JSON 对象`);
    return null;
  }
  const record = raw as RawRun;
  const required: (keyof RawRun)[] = [
    "testName",
    "program",
    "exitStatus",
    "exitCode",
    "stdoutSummary",
    "seed",
    "envWhitelist",
    "virtualTimeEvents",
    "schedule",
  ];
  for (const key of required) {
    if (record[key] === undefined) {
      errors.push(`第 ${line + 1} 行：缺少字段 ${String(key)}`);
      return null;
    }
  }

  const provided = record.fingerprint;
  const payload = { ...record };
  delete payload.id;
  delete payload.importedAt;
  delete payload.fingerprint;

  const expected = runFingerprint(payload);
  if (!recompute && provided !== undefined && provided !== expected) {
    errors.push(
      `第 ${line + 1} 行：运行指纹不匹配（记录可能被改动；${record.testName}）`,
    );
    return null;
  }

  const fingerprint = recompute || provided === undefined ? expected : provided;
  return {
    id:
      typeof record.id === "string" && record.id
        ? record.id
        : `run-${expected.slice(0, 12)}`,
    importedAt:
      typeof record.importedAt === "string"
        ? record.importedAt
        : new Date(0).toISOString(),
    fingerprint,
    ...payload,
    tempRoots: payload.tempRoots ?? [],
  };
}

export function assertValidRun(run: TestRun): boolean {
  return verifyFingerprint(run);
}

export function defaultDataFile(): string {
  return join(process.cwd(), ".data", "flaky-store.json");
}
