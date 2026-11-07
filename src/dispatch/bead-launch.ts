import { closeSync, openSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { DispatchBead } from "../queue/bd-client.ts";
import type { RunReceipt } from "../run/receipts.ts";
import type { KnownSlug } from "../run/signals.ts";
import type { CrankState } from "./crank-state.ts";
import type { SlotState } from "./slots.ts";

import { kilnConfig } from "../config/config.ts";
import { bd, bdComments, claimNextReady, releaseSlotClaim, unclaimFromSlot } from "../queue/bd-client.ts";
import { typeFromTitle } from "../run/branches.ts";
import { knownSlugs } from "../run/signals.ts";
import { spawnKiln } from "../shared/kiln-cli.ts";
import { agentRunsPath, ensureDir, timestampSlug } from "../shared/run-artifacts.ts";
import { provisionSlotLogged } from "../vm/provision-logged.ts";
import { didCloseLandedPr, landingOf } from "./gate-pass.ts";
import { composeBrief, modelFromLabels, slugForBead } from "./launch-inputs.ts";
import { readReceipts } from "./reconcile.ts";
import { dispatchComment, priorLaunch } from "./run-attempts.ts";
import { launchCapacity } from "./slots.ts";

export async function fillSlots(
  crankState: CrankState,
  ready: Array<DispatchBead>,
  maxLaunch: number,
  alreadyFilled: Set<string>,
): Promise<Set<string>> {
  const { flags, isQuiet, repoRoot, slots } = crankState;
  const filled = new Set<string>();
  const busyCount = slots.filter((slot) => slot.busy || alreadyFilled.has(slot.name)).length;
  const freeSlots = slots.filter((slot) => !slot.busy && !alreadyFilled.has(slot.name));
  const capacity = launchCapacity(flags.dial, busyCount, freeSlots.length, maxLaunch);
  const idle = idleReason({
    busyCount,
    capacity,
    dial: flags.dial,
    freeCount: freeSlots.length,
    readyCount: ready.length,
  });
  if (idle !== undefined) {
    if (!isQuiet) console.log(idle);
    return filled;
  }

  if (flags.isDryRun) {
    previewDispatch(ready.slice(0, capacity), freeSlots);
    return filled;
  }
  const slugs = knownSlugs(repoRoot);
  // Read fresh rather than from the crank's snapshot, so a relaunch brief sees a receipt that arrived since
  const receipts = readReceipts(repoRoot);
  for (const slot of freeSlots.slice(0, capacity)) {
    const bead = claimUnlandedBead(slot.name);
    if (bead === undefined) {
      break;
    }
    await dispatchToSlot(repoRoot, slot, bead, { receipts, slugs });
    filled.add(slot.name);
  }
  if (filled.size > 0) {
    console.log(
      `\n${String(filled.size)} run(s) launched detached; receipts land in ${agentRunsPath(repoRoot, "runs.jsonl")}.`,
    );
  }
  return filled;
}

// A bead whose PR merged outside the crank can still reach bd ready, and launching it would redo merged work
/** @internal */
export function claimUnlandedBead(slotName: string): DispatchBead | undefined {
  for (;;) {
    const bead = claimNextReady(slotName);
    const landing = bead === undefined ? undefined : landingOf(bead.id);
    if (bead === undefined || landing?.kind === "unlanded") {
      return bead;
    }
    if (landing?.kind !== "landed") {
      unclaimFromSlot(
        bead.id,
        slotName,
        "GitHub could not say whether its resolved PR gate's PR landed; left for the next crank",
      );
      return undefined;
    }
    // bd won't close a bead another actor holds, so the claim goes first; if the close fails, the next crank's stranded sweep closes it
    releaseSlotClaim(bead.id, slotName);
    didCloseLandedPr(bead.id, landing.prNumber);
  }
}

interface CrankLoad {
  busyCount: number;
  capacity: number;
  dial: number;
  freeCount: number;
  readyCount: number;
}

/** @internal */
export function idleReason(load: CrankLoad): string | undefined {
  if (load.capacity <= 0) {
    return `no capacity: ${String(load.busyCount)} run(s) in flight, dial ${String(load.dial)}, ${String(load.freeCount)} free slot(s)`;
  }
  if (load.readyCount === 0) return "nothing ready to dispatch";
  return undefined;
}

function previewDispatch(ready: Array<DispatchBead>, freeSlots: Array<SlotState>): void {
  for (const [index, bead] of ready.entries()) {
    const slot = freeSlots[index];
    if (slot === undefined) {
      break;
    }
    console.log(
      `would dispatch ${bead.id} (${bead.title}) to ${slot.name} as ${typeFromTitle(bead.title)}/${slugForBead(bead)}`,
    );
  }
}

async function dispatchToSlot(
  repoRoot: string,
  slot: SlotState,
  bead: DispatchBead,
  context: { receipts: Array<RunReceipt>; slugs: Array<KnownSlug> },
): Promise<void> {
  const model = modelFromLabels(bead.labels, kilnConfig.dispatch.models);
  const slug = slugForBead(bead);
  const type = typeFromTitle(bead.title);
  const branch = `${type}/${slug}`;
  const briefPath = agentRunsPath(repoRoot, "briefs", `${bead.id}-${slug}.md`);
  const startNote = slot.ready ? "" : " (provisioning it first)";
  console.log(`dispatching ${bead.id} (${bead.title}) to ${slot.name}${startNote} as ${branch}`);
  const prior = priorLaunch(bdComments(bead.id), context.receipts, bead.id);
  const brief = composeBrief(bead, branch, context.slugs, prior);
  ensureDir(path.dirname(briefPath));
  writeFileSync(briefPath, brief);
  const runArgs = [
    "run",
    slot.name,
    "--brief",
    briefPath,
    "--slug",
    slug,
    "--type",
    type,
    "--bead",
    bead.id,
    "--model",
    model,
  ];
  try {
    if (!slot.ready) {
      await provisionSlotLogged(repoRoot, slot.name);
    }
    // Written after provisioning, because reconcile dates the run from this comment
    bd(["comment", bead.id, dispatchComment(slot.name, branch)]);
    launchDetached(repoRoot, bead.id, runArgs);
  } catch (error) {
    unclaimFromSlot(bead.id, slot.name, `launch on ${slot.name} failed before the run started; requeued`);
    throw error;
  }
}

function launchDetached(repoRoot: string, beadId: string, runArgs: Array<string>): void {
  ensureDir(agentRunsPath(repoRoot, "launches"));
  const logPath = agentRunsPath(repoRoot, "launches", `${beadId}-${timestampSlug()}.log`);
  const fd = openSync(logPath, "a");
  const child = spawnKiln(runArgs, {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.on("error", (error) => {
    console.error(`detached launch for ${beadId} failed: ${error.message}`);
  });
  child.unref();
  closeSync(fd);
  console.log(`  launched detached (wrapper log: ${path.relative(repoRoot, logPath)})`);
}
