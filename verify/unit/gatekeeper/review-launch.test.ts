import { describe, expect, it } from "vitest";

import type { ReviewCandidate, ReviewMarker, ReviewProgress } from "#src/gatekeeper/review-launch.ts";

import {
  attemptComment,
  attemptsAtHead,
  decideReview,
  escalationDoubt,
  needsHumanLabel,
  reviewLaunchArgs,
} from "#src/gatekeeper/review-launch.ts";

const gatekeeperLogin = "sample-gatekeeper";
const reviewedSha = "4c0857af79b6eff47e4c9412ff8d3ca58c094a91";

function attempt(
  sha = reviewedSha,
  launchTag = "kiln-1 2026-07-21T09:00:00.000Z",
): { authorLogin: string; body: string } {
  return { authorLogin: gatekeeperLogin, body: attemptComment(sha, launchTag) };
}

function candidate(overrides: Partial<ReviewCandidate> = {}): ReviewCandidate {
  return {
    comments: [],
    headSha: reviewedSha,
    isDraft: false,
    labels: [],
    number: 106,
    state: "OPEN",
    ...overrides,
  };
}

function escalated(comments: ReviewCandidate["comments"]): ReviewCandidate {
  return candidate({ comments, labels: ["agent", needsHumanLabel] });
}

function marker(overrides: Partial<ReviewMarker> = {}): ReviewMarker {
  return {
    launchedAt: "2026-07-21T09:00:00.000Z",
    slot: "kiln-1",
    ...overrides,
  };
}

function progress(overrides: Partial<ReviewProgress> = {}): ReviewProgress {
  return { hasReceipt: false, isHolding: false, marker: undefined, ...overrides };
}

function launched(overrides: Partial<ReviewProgress> = {}): ReviewProgress {
  return progress({ marker: marker(), ...overrides });
}

describe("attemptsAtHead", () => {
  it("counts the gatekeeper's attempt stamps at this head", () => {
    const stamped = candidate({ comments: [attempt(), attempt(reviewedSha, "kiln-2 2026-07-21T10:00:00.000Z")] });
    expect(attemptsAtHead(stamped, gatekeeperLogin)).toBe(2);
    expect(attemptsAtHead(candidate(), gatekeeperLogin)).toBe(0);
  });

  it("counts one launch however many times its stamp was posted", () => {
    const stamped = candidate({ comments: [attempt(), attempt()] });
    expect(attemptsAtHead(stamped, gatekeeperLogin)).toBe(1);
  });

  it("counts an untagged stamp", () => {
    const stamped = candidate({
      comments: [{ authorLogin: gatekeeperLogin, body: `gatekeeper attempt at head ${reviewedSha}` }],
    });
    expect(attemptsAtHead(stamped, gatekeeperLogin)).toBe(1);
  });

  it("ignores stamps at another head and stamp-shaped text from another author", () => {
    const comments = [
      attempt("aaaa1111"),
      { authorLogin: "sample-agent", body: attemptComment(reviewedSha, "kiln-1 x") },
    ];
    expect(attemptsAtHead(candidate({ comments }), gatekeeperLogin)).toBe(0);
  });
});

describe("decideReview", () => {
  it("launches a fresh open PR with no marker", () => {
    expect(decideReview(candidate(), gatekeeperLogin, progress())).toStrictEqual({
      action: "launch",
      attempts: 1,
    });
  });

  it("skips a draft and a non-open PR", () => {
    expect(decideReview(candidate({ isDraft: true }), gatekeeperLogin, progress())).toStrictEqual({
      action: "skip",
      reason: "not-open",
    });
    expect(decideReview(candidate({ state: "MERGED" }), gatekeeperLogin, progress())).toStrictEqual({
      action: "skip",
      reason: "not-open",
    });
  });

  it("skips when the gatekeeper already commented on this head", () => {
    const reviewed = candidate({
      comments: [{ authorLogin: gatekeeperLogin, body: `reviewed head \`${reviewedSha}\`` }],
    });
    expect(decideReview(reviewed, gatekeeperLogin, progress())).toStrictEqual({
      action: "skip",
      reason: "reviewed",
    });
  });

  it("never reads an attempt stamp as the review itself", () => {
    const stamped = candidate({ comments: [attempt()] });
    expect(decideReview(stamped, gatekeeperLogin, progress())).toStrictEqual({ action: "launch", attempts: 2 });
  });

  it("ignores a head-SHA mention from any other author", () => {
    const authored = candidate({
      comments: [{ authorLogin: "sample-agent", body: `pushed ${reviewedSha}` }],
    });
    expect(decideReview(authored, gatekeeperLogin, progress())).toStrictEqual({
      action: "launch",
      attempts: 1,
    });
  });

  it("ignores a gatekeeper comment about an older head", () => {
    const stale = candidate({
      comments: [{ authorLogin: gatekeeperLogin, body: "reviewed head `aaaa1111`" }],
    });
    expect(decideReview(stale, gatekeeperLogin, progress())).toStrictEqual({ action: "launch", attempts: 1 });
  });

  it("holds while the launched run is still in flight", () => {
    const stamped = candidate({ comments: [attempt()] });
    expect(decideReview(stamped, gatekeeperLogin, launched({ isHolding: true }))).toStrictEqual({
      action: "skip",
      reason: "in-flight",
    });
  });

  it("relaunches after a run that ended without commenting, counting the attempt", () => {
    const stamped = candidate({ comments: [attempt()] });
    expect(decideReview(stamped, gatekeeperLogin, launched({ hasReceipt: true, isHolding: true }))).toStrictEqual({
      action: "launch",
      attempts: 2,
    });
    expect(decideReview(stamped, gatekeeperLogin, launched())).toStrictEqual({
      action: "launch",
      attempts: 2,
    });
  });

  it("stops after the attempt cap and waits for a human, marker or no marker", () => {
    const exhausted = candidate({ comments: [attempt(), attempt(reviewedSha, "kiln-2 2026-07-21T10:00:00.000Z")] });
    expect(decideReview(exhausted, gatekeeperLogin, launched({ hasReceipt: true }))).toStrictEqual({
      action: "skip",
      reason: "attempts-exhausted",
    });
    expect(decideReview(exhausted, gatekeeperLogin, progress())).toStrictEqual({
      action: "skip",
      reason: "attempts-exhausted",
    });
  });

  it("starts the count fresh when the PR head moved past the stamps", () => {
    const repushed = candidate({
      comments: [attempt("aaaa1111"), attempt("aaaa1111", "kiln-2 2026-07-21T10:00:00.000Z")],
    });
    expect(decideReview(repushed, gatekeeperLogin, progress())).toStrictEqual({
      action: "launch",
      attempts: 1,
    });
  });
});

describe("escalationDoubt", () => {
  it("hands back the gatekeeper's doubt verbatim, since a human reads it in the park comment", () => {
    const body = `Escalating at \`${reviewedSha}\`. Gate green.\nThe migration drops a column a caller still reads.`;
    expect(escalationDoubt(escalated([{ authorLogin: gatekeeperLogin, body }]), gatekeeperLogin)).toBe(body);
  });

  it("takes the latest gatekeeper comment, skipping stamps and everyone else", () => {
    const doubt = escalationDoubt(
      escalated([
        { authorLogin: gatekeeperLogin, body: "reviewed head `aaaa1111`, merged" },
        { authorLogin: "sample-agent", body: "pushed a fix" },
        { authorLogin: gatekeeperLogin, body: "  the new assertion cannot fail  " },
        attempt(),
      ]),
      gatekeeperLogin,
    );
    expect(doubt).toBe("the new assertion cannot fail");
  });

  it("names the label when a human escalated by hand, leaving no comment", () => {
    expect(escalationDoubt(escalated([]), gatekeeperLogin)).toBe(`labeled ${needsHumanLabel} by hand`);
    expect(escalationDoubt(escalated([{ authorLogin: "operator", body: "look at this" }]), gatekeeperLogin)).toBe(
      `labeled ${needsHumanLabel} by hand`,
    );
  });

  it("is silent without the label, whatever the gatekeeper said", () => {
    const doubted = candidate({
      comments: [{ authorLogin: gatekeeperLogin, body: `escalating \`${reviewedSha}\`` }],
    });
    expect(escalationDoubt(doubted, gatekeeperLogin)).toBeUndefined();
  });
});

describe("reviewLaunchArgs", () => {
  it("tells the spawned run its ledger is already written", () => {
    expect(reviewLaunchArgs("kiln-1", 361, undefined)).toStrictEqual(["review", "kiln-1", "--pr", "361", "--stamped"]);
  });

  it("carries the spec bead as review context when the PR has one", () => {
    expect(reviewLaunchArgs("kiln-2", 361, "bd-42").slice(-2)).toStrictEqual(["--bead", "bd-42"]);
  });
});
