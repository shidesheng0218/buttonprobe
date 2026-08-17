import { createHash } from "node:crypto";
import type { RepairProofV2 } from "./types.js";

export type RepairProofV2Input = Omit<RepairProofV2, "schemaVersion" | "patch"> & {
  patch: { source: string; content: string };
};

function assertValidProof(input: RepairProofV2Input): void {
  if (input.status === "ui-verified") {
    if (!input.target?.patchedWorks || !input.tests.passed || input.regressions.length > 0) {
      throw new Error("ui-verified proofs require a working target, passing tests, and no regressions");
    }
    if (!input.browsers.length || input.browsers.some((browser) => browser.status !== "passed")) {
      throw new Error("ui-verified proofs require every requested browser to pass");
    }
    if (input.scenario && !input.scenario.passed) {
      throw new Error("ui-verified proofs require scenario verification to pass");
    }
  }
  if (input.status !== "ui-verified" && input.target?.patchedWorks) {
    throw new Error("only ui-verified proofs may claim the target was fixed");
  }
}

export function createRepairProofV2(input: RepairProofV2Input): RepairProofV2 {
  assertValidProof(input);
  return {
    schemaVersion: 2,
    ...input,
    patch: {
      source: input.patch.source,
      sha256: createHash("sha256").update(input.patch.content).digest("hex")
    }
  };
}

export function proofArtifactPaths(proof: Pick<RepairProofV2, "artifacts">): string[] {
  return [
    proof.artifacts.report,
    ...(proof.artifacts.verifiedDiff ? [proof.artifacts.verifiedDiff] : []),
    ...proof.artifacts.screenshots,
    proof.artifacts.testLog
  ];
}
