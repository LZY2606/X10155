import { createHash } from "node:crypto";

/**
 * Deterministic JSON serialization: object keys sorted recursively.
 * Used for fingerprinting so export -> import round-trips are byte-stable.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    "{" +
    keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key])).join(",") +
    "}"
  );
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
