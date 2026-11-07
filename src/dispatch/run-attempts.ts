import type { BeadComment } from "../queue/bd-client.ts";
import type { RunReceipt } from "../run/receipts.ts";
import type { PriorLaunch } from "./launch-inputs.ts";

import { dispatchActor } from "../queue/bd-client.ts";
import { settlementOf } from "../run/receipts.ts";
import { latestReceiptForBead } from "./run-ledger.ts";

const dispatchCommentPrefix = "dispatched to ";

const outageDeaths = 2;
const outageWindowMs = 15 * 60_000;

const maxUnchargedProviderDeaths = 5;

export function dispatchComment(slot: string, branch: string): string {
  return `${dispatchCommentPrefix}${slot} as ${branch}`;
}

export function latestDispatchBranch(comments: Array<BeadComment>): string | undefined {
  const latest = dispatchComments(comments)
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1);
  return latest === undefined ? undefined : / as (\S+)$/.exec(latest.text)?.[1];
}

export function latestDispatchTime(comments: Array<BeadComment>): string | undefined {
  // bd writes created_at in one fixed ISO format, so the largest string is the latest time
  return dispatchComments(comments)
    .map((comment) => comment.createdAt)
    .toSorted()
    .at(-1);
}

// Read before this launch writes its own dispatch comment, hence `launches + 1`
export function priorLaunch(
  comments: Array<BeadComment>,
  receipts: Array<RunReceipt>,
  beadId: string,
): PriorLaunch | undefined {
  const launches = dispatchComments(comments).length;
  if (launches === 0) {
    return undefined;
  }
  const receipt = latestReceiptForBead(receipts, beadId, latestDispatchTime(comments));
  return { launch: launches + 1, stopReason: receipt?.stopReason };
}

export function shouldHoldForOutage(receipts: Array<RunReceipt>, nowMs: number): boolean {
  const recent = receipts.filter((receipt) => {
    const endedMs = Date.parse(receipt.endedAt);
    return !Number.isNaN(endedMs) && nowMs - endedMs < outageWindowMs;
  });
  return recent.length >= outageDeaths && recent.every((receipt) => isProviderDeath(receipt));
}

export function spentAttempts(comments: Array<BeadComment>, receipts: Array<RunReceipt>, beadId: string): number {
  const launches = dispatchComments(comments).length;
  const own = receipts.filter((receipt) => receipt.bead === beadId);
  const aborted = own.filter((receipt) => settlementOf(receipt) === "aborted").length;
  const providerDeaths = own.filter((receipt) => isProviderDeath(receipt)).length;
  return Math.max(0, launches - aborted - Math.min(providerDeaths, maxUnchargedProviderDeaths));
}

function dispatchComments(comments: Array<BeadComment>): Array<BeadComment> {
  return comments.filter(
    (comment) => comment.author === dispatchActor && comment.text.startsWith(dispatchCommentPrefix),
  );
}

function isProviderDeath(receipt: RunReceipt): boolean {
  return receipt.stopReason === "failed:api_error" && (receipt.commits ?? 0) === 0;
}
