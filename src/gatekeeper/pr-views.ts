import { z } from "zod";

import type { ReviewCandidate } from "./review-launch.ts";

import { kilnConfig } from "../config/config.ts";
import { optionalText, parseEach, parseJson } from "../shared/lenient-json.ts";
import { safeCapture } from "../shared/run-artifacts.ts";

const prAuthorSchema = z.object({ login: optionalText });

const prCommentSchema = z.object({
  author: z
    .unknown()
    .transform((author) => prAuthorSchema.safeParse(author).data)
    .optional(),
  body: optionalText,
});

const prLabelSchema = z.object({ name: z.string() });

const prCandidateSchema = z.object({
  comments: z.unknown().transform((comments) => parseEach(prCommentSchema, comments)),
  headRefOid: z.string(),
  isDraft: z.unknown().transform((isDraft) => isDraft === true),
  labels: z.unknown().transform((labels) => parseEach(prLabelSchema, labels)),
  state: z.string(),
});

const prListingSchema = z.object({
  body: optionalText,
  createdAt: z.string(),
  state: z.string(),
  url: z.string(),
});

const prNumberSchema = z.object({ number: z.number().refine((value) => Number.isSafeInteger(value)) });

export function fetchReviewCandidate(prNumber: number): ReviewCandidate | undefined {
  const raw = safeCapture("gh", [
    "pr",
    "view",
    String(prNumber),
    "--repo",
    kilnConfig.identity.githubRepo,
    "--json",
    "state,isDraft,headRefOid,comments,labels",
  ]);
  const parsed = prCandidateSchema.safeParse(parseJson(raw));
  if (!parsed.success) {
    return undefined;
  }
  const { comments, headRefOid, isDraft, labels, state } = parsed.data;
  return {
    comments: comments.map((comment) => ({ authorLogin: comment.author?.login ?? "", body: comment.body ?? "" })),
    headSha: headRefOid,
    isDraft,
    labels: labels.map((label) => label.name),
    number: prNumber,
    state,
  };
}

export function fetchPrState(prNumber: number): string | undefined {
  const state = safeCapture("gh", [
    "pr",
    "view",
    String(prNumber),
    "--repo",
    kilnConfig.identity.githubRepo,
    "--json",
    "state",
    "--jq",
    ".state",
  ])?.trim();
  if (state === undefined || state === "") {
    return undefined;
  }
  return state;
}

export function unclosedPrUrlsForHead(head: string, since: string): Array<string> | undefined {
  return unclosedPrUrls(["--head", head], since);
}

// A bead's PR body carries a `Bead:` line (envelope.md), which is all an attended claim leaves to find its PR by
export function unclosedPrUrlsForBead(beadId: string, since: string): Array<string> | undefined {
  const beadLine = `Bead: ${beadId}`;
  return unclosedPrUrls(["--search", `"${beadLine}" in:body`], since, (body) =>
    body.split("\n").some((line) => line.trim() === beadLine),
  );
}

// Open or merged, since a PR can land between a run's death and the crank that reads it; undefined when gh cannot answer
function unclosedPrUrls(
  filter: Array<string>,
  since: string,
  isOwnBody: (body: string) => boolean = () => true,
): Array<string> | undefined {
  const raw = safeCapture("gh", [
    "pr",
    "list",
    "--repo",
    kilnConfig.identity.githubRepo,
    ...filter,
    "--state",
    "all",
    "--json",
    "body,createdAt,state,url",
  ]);
  const listed = parseJson(raw);
  if (!Array.isArray(listed)) {
    return undefined;
  }
  const sinceMs = Date.parse(since);
  return parseEach(prListingSchema, listed)
    .filter((pr) => pr.state !== "CLOSED" && isOwnBody(pr.body ?? ""))
    .filter((pr) => Number.isNaN(sinceMs) || Date.parse(pr.createdAt) >= sinceMs)
    .map((pr) => pr.url);
}

export function labeledReviewPrs(): Array<number> {
  const raw = safeCapture("gh", [
    "pr",
    "list",
    "--repo",
    kilnConfig.identity.githubRepo,
    "--label",
    "gatekeeper",
    "--state",
    "open",
    "--json",
    "number",
  ]);
  return parseEach(prNumberSchema, parseJson(raw)).map((pr) => pr.number);
}
