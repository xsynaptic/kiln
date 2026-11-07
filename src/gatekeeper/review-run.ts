import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

import type { KnownSlug } from "../run/signals.ts";

import { gatekeeperPatFile, kilnConfig } from "../config/config.ts";
import { isBranchType } from "../run/branches.ts";
import { startRun } from "../run/launch-run.ts";
import { parseArgs } from "../run/run-args.ts";
import { knownSlugs } from "../run/signals.ts";
import { capture } from "../shared/proc.ts";
import { agentRunsPath, ensureDir, mainCheckoutPath } from "../shared/run-artifacts.ts";
import { stampReviewLaunch } from "./review-ledger.ts";

/** @internal */
export interface ReviewBrief {
  beadId: string | undefined;
  headRefName: string;
  headSha: string;
  knownSlugs: Array<KnownSlug>;
  prNumber: number;
  title: string;
  url: string;
}

const prViewSchema = z.object({
  headRefName: z.string(),
  headRefOid: z.string(),
  isDraft: z.boolean(),
  state: z.string(),
  title: z.string(),
  url: z.string(),
});

type PrView = z.output<typeof prViewSchema>;

export interface ReviewArgs {
  beadId: string | undefined;
  isStamped: boolean;
  name: string;
  prNumber: number;
}

/** @internal */
export function composeReviewBrief(brief: ReviewBrief): string {
  const number = String(brief.prNumber);
  const lines = [
    `# Gatekeeper review of PR #${number}: ${brief.title}`,
    "",
    `You are the repository gatekeeper. Review PR #${number} and decide whether it lands.`,
    "",
    `- PR: ${brief.url}`,
    `- Head branch: ${brief.headRefName} (checked out at its current head)`,
    `- Head SHA at brief time: ${brief.headSha}`,
    brief.beadId === undefined
      ? "- Spec bead: none. This PR was opted into review by label rather than dispatched from a bead, so its body is the only statement of intent you have."
      : `- Spec bead: ${brief.beadId}. Read it (\`bd show ${brief.beadId}\`) before the diff: it is what the work was asked to do.`,
  ];
  if (brief.knownSlugs.length > 0) {
    lines.push(
      "",
      "## Signal slugs already on file",
      "",
      "Most-sighted first, each with the gist of its first sighting.",
      "",
      ...brief.knownSlugs.map(({ gist, slug }) => `- \`${slug}\`: ${gist}`),
    );
  }
  return lines.join("\n");
}

export async function startReview({ beadId, isStamped, name, prNumber }: ReviewArgs): Promise<void> {
  process.env.KILN_GITHUB_PAT_FILE = verifiedGatekeeperPat();

  const pr = viewOpenPr(prNumber);
  const [type, ...slugParts] = pr.headRefName.split("/");
  const slug = slugParts.join("/");
  if (type === undefined || !isBranchType(type) || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`head branch ${pr.headRefName} is not <type>/<slug>; review this PR by hand`);
  }

  const repoRoot = mainCheckoutPath();
  const briefPath = agentRunsPath(repoRoot, "briefs", `review-pr-${String(prNumber)}.md`);
  ensureDir(path.dirname(briefPath));
  writeFileSync(
    briefPath,
    composeReviewBrief({
      beadId,
      headRefName: pr.headRefName,
      headSha: pr.headRefOid,
      knownSlugs: knownSlugs(repoRoot),
      prNumber,
      title: pr.title,
      url: pr.url,
    }),
  );

  if (!isStamped) {
    stampReviewLaunch(repoRoot, prNumber, pr.headRefOid, name);
  }

  // No --bead, or this receipt would be mistaken for the authoring run's
  await startRun(
    parseArgs([
      name,
      "--brief",
      briefPath,
      "--review",
      String(prNumber),
      "--slug",
      slug,
      "--type",
      type,
      "--base",
      pr.headRefName,
      "--model",
      kilnConfig.dispatch.reviewModel,
      "--readonly-task-state",
    ]),
  );
}

// A token for another account would never fail, and would relaunch this review on every crank instead
function verifiedGatekeeperPat(): string {
  const patFile = gatekeeperPatFile();
  if (!existsSync(patFile)) {
    throw new Error(
      `no gatekeeper PAT at ${patFile}; create the machine-user token first and drop it there (chmod 600)`,
    );
  }
  const env = { ...process.env, GH_TOKEN: readFileSync(patFile, "utf8").trim() };
  const login = spawnSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8", env }).stdout.trim();
  if (kilnConfig.identity.gatekeeperLogin !== undefined && login !== kilnConfig.identity.gatekeeperLogin) {
    throw new Error(
      `the gatekeeper PAT at ${patFile} authenticates as ${login || "nobody"}, not the configured ${kilnConfig.identity.gatekeeperLogin}`,
    );
  }
  return patFile;
}

function viewOpenPr(prNumber: number): PrView {
  const raw = capture("gh", [
    "pr",
    "view",
    String(prNumber),
    "--repo",
    kilnConfig.identity.githubRepo,
    "--json",
    "headRefName,headRefOid,isDraft,state,title,url",
  ]);
  const pr = prViewSchema.parse(JSON.parse(raw));
  if (pr.state !== "OPEN" || pr.isDraft) {
    throw new Error(
      `PR #${String(prNumber)} is ${pr.isDraft ? "a draft" : pr.state}; only open, non-draft PRs get a gatekeeper run`,
    );
  }
  return pr;
}
