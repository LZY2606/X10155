import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/server/store";
import { runFingerprint } from "../../src/core/fingerprint";
import type { TestRun } from "../../src/core/types";

const dirs: string[] = [];
function newStore() {
  const dir = mkdtempSync(join(tmpdir(), "flaky-store-"));
  dirs.push(dir);
  return new Store(join(dir, "store.json"));
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function record(id: string, summary: string): TestRun {
  const base = {
    testName: "T",
    program: "data-race",
    exitStatus: "failed" as const,
    exitCode: 1,
    errorType: "AssertionError",
    stdoutSummary: summary,
    seed: id,
    envWhitelist: {},
    virtualTimeEvents: [],
    schedule: [],
    tempRoots: [],
  };
  return {
    id,
    importedAt: `2026-01-01T00:00:${id.slice(-2)}.000Z`,
    fingerprint: runFingerprint(base),
    ...base,
  };
}

describe("store import/export", () => {
  it("preserves fingerprints and import order across export -> import", () => {
    const store = newStore();
    const first = [record("id-01", "a at t.ts:1"), record("id-02", "b at t.ts:2")];
    const r1 = store.importRecords(first, { now: () => new Date() });
    expect(r1.imported).toBe(2);

    // Re-import same payload: fingerprints dedupe, members stay in order.
    const r2 = store.importRecords(
      [record("id-01", "a at t.ts:1"), record("id-03", "c at t.ts:3")],
      { now: () => new Date() },
    );
    expect(r2.imported).toBe(1);
    expect(r2.skipped).toBe(1);

    const exported = store
      .exportNdjson()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TestRun);
    expect(exported.map((run) => run.id)).toEqual(["id-01", "id-02", "id-03"]);
    expect(exported.map((run) => run.fingerprint)).toEqual(
      [record("id-01", "a at t.ts:1"), record("id-02", "b at t.ts:2"), record("id-03", "c at t.ts:3")].map(
        (run) => run.fingerprint,
      ),
    );

    // A fresh store importing the export accepts every line (verified fp).
    const store2 = newStore();
    const r3 = store2.importRecords(exported, { now: () => new Date() });
    expect(r3.errors).toHaveLength(0);
    expect(r3.imported).toBe(3);
  });

  it("rejects tampered records by fingerprint unless recompute requested", () => {
    const store = newStore();
    const tampered = record("id-t", "original at t.ts:5");
    tampered.stdoutSummary = "TAMPERED at t.ts:5";
    const result = store.importRecords([tampered], { now: () => new Date() });
    expect(result.imported).toBe(0);
    expect(result.errors[0]).toMatch(/指纹不匹配/);

    const recomputed = store.importRecords([tampered], {
      now: () => new Date(),
      recomputeFingerprint: true,
    });
    expect(recomputed.imported).toBe(1);
  });

  it("persists data to disk and reloads it", () => {
    const dir = mkdtempSync(join(tmpdir(), "flaky-reload-"));
    dirs.push(dir);
    const file = join(dir, "nested", "store.json");
    const store = new Store(file);
    store.importRecords([record("id-x", "x at t.ts:1")], {
      now: () => new Date(),
    });
    expect(existsSync(file)).toBe(true);
    const reloaded = new Store(file);
    expect(reloaded.getRuns()).toHaveLength(1);
    expect(reloaded.getRun("id-x")?.fingerprint).toBe(
      record("id-x", "x at t.ts:1").fingerprint,
    );
  });
});
