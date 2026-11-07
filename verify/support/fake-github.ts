import type { ReviewCandidate } from "#src/gatekeeper/review-launch.ts";

import type { PrState } from "./fake-bd.ts";

export interface FakePr {
  bead: string;
  createdAt: string;
  head: string;
  labels: Array<string>;
  number: number;
  state: PrState;
}

export function prUrl(prNumber: number): string {
  return `https://github.com/acme/sample/pull/${String(prNumber)}`;
}

// Stands in for the gh reads in pr-views.ts; every PR body carries its bead's `Bead:` line
export function createFakeGithub() {
  const prs: Array<FakePr> = [];
  // An outage fails every gh read, as an expired token or a network drop would
  const reach = { isReachable: true };

  function open(bead: string, head: string): FakePr {
    const pr: FakePr = {
      bead,
      createdAt: new Date().toISOString(),
      head,
      labels: [],
      number: prs.length + 1,
      state: "OPEN",
    };
    prs.push(pr);
    return pr;
  }

  function fetchPrState(prNumber: number): PrState | undefined {
    return reach.isReachable ? prs.find((pr) => pr.number === prNumber)?.state : undefined;
  }

  function fetchReviewCandidate(prNumber: number): ReviewCandidate | undefined {
    const pr = prs.find((candidate) => candidate.number === prNumber);
    if (pr === undefined || !reach.isReachable) {
      return undefined;
    }
    return {
      comments: [],
      headSha: "0".repeat(40),
      isDraft: false,
      labels: [...pr.labels],
      number: pr.number,
      state: pr.state,
    };
  }

  function unclosed(isMatch: (pr: FakePr) => boolean, since: string): Array<string> | undefined {
    if (!reach.isReachable) {
      return undefined;
    }
    return prs
      .filter((candidate) => isMatch(candidate) && candidate.state !== "CLOSED")
      .filter((candidate) => Date.parse(candidate.createdAt) >= Date.parse(since))
      .map((pr) => prUrl(pr.number))
      .toReversed();
  }

  return {
    fetchPrState,
    fetchReviewCandidate,
    open,
    prs,
    reach,
    unclosedPrUrlsForBead: (beadId: string, since: string) => unclosed((pr) => pr.bead === beadId, since),
    unclosedPrUrlsForHead: (head: string, since: string) => unclosed((pr) => pr.head === head, since),
  };
}

export type FakeGithub = ReturnType<typeof createFakeGithub>;
