import { createHash } from "node:crypto";
import type { RunRecord } from "./types.js";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") +
    "}"
  );
}

export function runFingerprint(run: RunRecord): string {
  return sha256Hex(
    canonicalJson({
      testName: run.testName,
      exitStatus: run.exitStatus,
      stdout: run.stdout,
      seed: run.seed,
      env: run.env,
      virtualTimeEvents: run.virtualTimeEvents,
      schedule: run.schedule,
    }),
  );
}
