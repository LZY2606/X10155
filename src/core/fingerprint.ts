import type { TestRun } from "./types";
import { canonicalJson, sha256 } from "./canonical";

/**
 * Fingerprint covers the observed run payload, excluding bookkeeping fields
 * (id, importedAt, fingerprint itself).
 */
export function runFingerprint(
  run: Omit<TestRun, "id" | "importedAt" | "fingerprint">,
): string {
  const payload = {
    testName: run.testName,
    program: run.program,
    exitStatus: run.exitStatus,
    exitCode: run.exitCode,
    errorType: run.errorType ?? null,
    stdoutSummary: run.stdoutSummary,
    seed: run.seed,
    envWhitelist: run.envWhitelist,
    virtualTimeEvents: run.virtualTimeEvents,
    schedule: run.schedule,
    tempRoots: run.tempRoots ?? [],
  };
  return sha256(canonicalJson(payload));
}

export function verifyFingerprint(run: TestRun): boolean {
  const { id: _id, importedAt: _importedAt, fingerprint, ...payload } = run;
  void _id;
  void _importedAt;
  return runFingerprint(payload) === fingerprint;
}
