import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";
import { z } from "zod";

import type { ReviewMarker } from "./review-launch.ts";

import { gatekeeperPatFile, kilnConfig } from "../config/config.ts";
import { parseJson } from "../shared/lenient-json.ts";
import { agentRunsPath, ensureDir } from "../shared/run-artifacts.ts";
import { attemptComment } from "./review-launch.ts";

const reviewMarkerSchema = z.object({ launchedAt: z.string(), slot: z.string() }) satisfies z.ZodType<ReviewMarker>;

export function deleteReviewMarker(repoRoot: string, prNumber: number): void {
  rmSync(reviewMarkerPath(repoRoot, prNumber), { force: true });
}

export function readReviewMarker(repoRoot: string, prNumber: number): ReviewMarker | undefined {
  const file = reviewMarkerPath(repoRoot, prNumber);
  if (!existsSync(file)) {
    return undefined;
  }
  return reviewMarkerSchema.safeParse(parseJson(readFileSync(file, "utf8"))).data;
}

export function reviewMarkerPrNumber(fileName: string): number | undefined {
  const match = /^review-pr-(\d+)\.json$/.exec(fileName);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function reviewMarkerPath(repoRoot: string, prNumber: number): string {
  return agentRunsPath(repoRoot, "launches", `review-pr-${String(prNumber)}.json`);
}

// Stamped first, so a launch that dies in between has still spent its attempt
export function stampReviewLaunch(repoRoot: string, prNumber: number, headSha: string, slot: string): void {
  const launchedAt = new Date().toISOString();
  postAttemptComment(prNumber, headSha, `${slot} ${launchedAt}`);
  writeReviewMarker(repoRoot, prNumber, slot, launchedAt);
}

// Posted as the gatekeeper, so no other author can inflate the attempt count
function postAttemptComment(prNumber: number, headSha: string, launchTag: string): void {
  const pat = readFileSync(gatekeeperPatFile(), "utf8").trim();
  const result = spawnSync(
    "gh",
    [
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      kilnConfig.identity.githubRepo,
      "--body",
      attemptComment(headSha, launchTag),
    ],
    { encoding: "utf8", env: { ...process.env, GH_TOKEN: pat } },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `could not stamp the attempt on PR #${String(prNumber)}`);
  }
}

function writeReviewMarker(repoRoot: string, prNumber: number, slot: string, launchedAt: string): void {
  ensureDir(agentRunsPath(repoRoot, "launches"));
  const marker: ReviewMarker = {
    launchedAt,
    slot,
  };
  writeFileSync(reviewMarkerPath(repoRoot, prNumber), JSON.stringify(marker));
}
