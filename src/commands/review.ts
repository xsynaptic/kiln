import type { ReviewArgs } from "../gatekeeper/review-run.ts";

import { startReview } from "../gatekeeper/review-run.ts";

/** @internal */
export function parseReviewArgs(argv: Array<string>): ReviewArgs {
  const name = argv[0];
  const prFlag = argv.indexOf("--pr");
  const prNumber = prFlag === -1 ? undefined : Number(argv[prFlag + 1]);
  const beadFlag = argv.indexOf("--bead");
  const beadId = beadFlag === -1 ? undefined : argv[beadFlag + 1];
  if (
    name === undefined ||
    prNumber === undefined ||
    name.startsWith("-") ||
    !Number.isSafeInteger(prNumber) ||
    (beadFlag !== -1 && (beadId === undefined || !/^[\w.-]+$/.test(beadId)))
  ) {
    throw new Error("usage: pnpm kiln review <kiln-n> --pr <number> [--bead <id>] [--stamped]");
  }
  return { beadId, isStamped: argv.includes("--stamped"), name, prNumber };
}

export async function run(argv: Array<string>): Promise<void> {
  await startReview(parseReviewArgs(argv));
}
