import { failureSignature } from "../core/normalize";
import { diffSummaries as coreDiff } from "../core/cluster";
import type { FailureSignature, TestRun } from "../core/types";

/** Comparison always uses the original v1 view so line/value changes show. */
export function failureSignatureForCompare(run: TestRun): FailureSignature {
  return failureSignature(run, "v1");
}

export { coreDiff as diffSummaries };
