import { parseDispatchArgs } from "../dispatch/dispatch-flags.ts";
import { crank } from "../dispatch/dispatch.ts";
import { mainCheckoutPath } from "../shared/run-artifacts.ts";
import { didEnsureBeadsServer } from "../vm/beads.ts";
import { acquireLease } from "../vm/lease.ts";

export async function run(argv: Array<string>): Promise<void> {
  const flags = parseDispatchArgs(argv);
  const repoRoot = mainCheckoutPath();
  const releaseLease = acquireLease(repoRoot, "dispatch", "dispatch");
  try {
    if (!didEnsureBeadsServer()) {
      console.error("beads store is unavailable and could not be started; nothing to dispatch");
      return;
    }
    const summary = await crank(flags, repoRoot);
    if (!flags.isDryRun && summary.launched > 0) {
      console.log("re-run 'pnpm kiln dispatch launch' after they finish to reconcile and fill slots again.");
    }
  } finally {
    releaseLease();
  }
}
