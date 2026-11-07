export interface ReviewCandidate {
  comments: Array<ReviewComment>;
  headSha: string;
  isDraft: boolean;
  labels: Array<string>;
  number: number;
  state: string;
}

export type ReviewLaunchDecision =
  | { action: "launch"; attempts: number }
  | {
      action: "skip";
      reason: "attempts-exhausted" | "in-flight" | "not-open" | "reviewed";
    };

export interface ReviewMarker {
  launchedAt: string;
  slot: string;
}

export interface ReviewProgress {
  hasReceipt: boolean;
  isHolding: boolean;
  marker: ReviewMarker | undefined;
}

interface ReviewComment {
  authorLogin: string;
  body: string;
}

/** @internal */
export const needsHumanLabel = "needs-human";

// Reviews merge with no PR CI, so two branches gated against different states of main could land together untested
export const maxInFlightReviews = 1;
export const maxReviewAttempts = 2;

export function attemptComment(headSha: string, launchTag: string): string {
  return `gatekeeper attempt at head ${headSha} (${launchTag})`;
}

// Counted by distinct stamps, because a stamp posted twice for one launch carries the same launch tag
/** @internal */
export function attemptsAtHead(candidate: ReviewCandidate, gatekeeperLogin: string): number {
  const stamps = new Set(
    candidate.comments
      .filter((comment) => comment.authorLogin === gatekeeperLogin && isAttemptAtHead(comment.body, candidate.headSha))
      .map((comment) => comment.body.trim()),
  );
  return stamps.size;
}

export function decideReview(
  candidate: ReviewCandidate,
  gatekeeperLogin: string,
  progress: ReviewProgress,
): ReviewLaunchDecision {
  if (candidate.state !== "OPEN" || candidate.isDraft) {
    return { action: "skip", reason: "not-open" };
  }
  const isReviewed = candidate.comments.some(
    (comment) =>
      comment.authorLogin === gatekeeperLogin &&
      comment.body.includes(candidate.headSha) &&
      !isAttemptComment(comment.body),
  );
  if (isReviewed) {
    return { action: "skip", reason: "reviewed" };
  }
  if (!progress.hasReceipt && progress.isHolding && progress.marker !== undefined) {
    return { action: "skip", reason: "in-flight" };
  }
  const attempts = attemptsAtHead(candidate, gatekeeperLogin);
  if (attempts >= maxReviewAttempts) {
    return { action: "skip", reason: "attempts-exhausted" };
  }
  return { action: "launch", attempts: attempts + 1 };
}

export function escalationDoubt(candidate: ReviewCandidate, gatekeeperLogin: string): string | undefined {
  if (!candidate.labels.includes(needsHumanLabel)) {
    return undefined;
  }
  const comment = candidate.comments.findLast(
    (entry) => entry.authorLogin === gatekeeperLogin && !isAttemptComment(entry.body),
  );
  const doubt = comment?.body.trim() ?? "";
  return doubt === "" ? `labeled ${needsHumanLabel} by hand` : doubt;
}

export function reviewLaunchArgs(slot: string, prNumber: number, beadId: string | undefined): Array<string> {
  const args = ["kiln", "review", slot, "--pr", String(prNumber), "--stamped"];
  if (beadId !== undefined) {
    args.push("--bead", beadId);
  }
  return args;
}

function isAttemptComment(body: string): boolean {
  return /^gatekeeper attempt at head [0-9a-f]{7,40}( \(.+\))?$/i.test(body.trim());
}

function isAttemptAtHead(body: string, headSha: string): boolean {
  return isAttemptComment(body) && body.includes(headSha);
}
