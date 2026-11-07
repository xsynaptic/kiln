import { existsSync, readFileSync } from "node:fs";

import type { RunReceipt } from "../run/receipts.ts";

import { prNumberFromUrl } from "../queue/gate-reads.ts";
import { settlementOf } from "../run/receipts.ts";
import { knownSlugsIn, slugRecency } from "../run/signals.ts";
import { agentRunsPath } from "../shared/run-artifacts.ts";
import { slugBlockLines } from "./launch-inputs.ts";

interface DaySummary {
  costUsd: number;
  day: string;
  flagged: Array<RunReceipt>;
  prs: number;
  runs: number;
  stopReasons: Map<string, number>;
}

interface LandingLag {
  minutes: number;
  pullRequest: string;
}

interface DurationBucket {
  delivered: number;
  label: string;
  runs: number;
}

const dayMs = 86_400_000;
const mergeDecisions = new Set<string>(["fixed-and-merged", "merged"]);

const durationBuckets = [
  { label: "under 15m", maxMinutes: 15 },
  { label: "15m to 30m", maxMinutes: 30 },
  { label: "30m to 1h", maxMinutes: 60 },
  { label: "1h to 2h", maxMinutes: 120 },
  { label: "over 2h", maxMinutes: Infinity },
] as const;

/** @internal */
export function decisionsBy(
  receipts: Array<RunReceipt>,
  field: "baseline" | "kit" | "model",
): Map<string, Map<string, number>> {
  const table = new Map<string, Map<string, number>>();
  for (const receipt of receipts) {
    if (receipt.review === undefined || receipt.decision === undefined) {
      continue;
    }
    const key = receipt[field] ?? "unrecorded";
    const row = table.get(key) ?? new Map<string, number>();
    row.set(receipt.decision, (row.get(receipt.decision) ?? 0) + 1);
    table.set(key, row);
  }
  return table;
}

/** @internal */
export function deliveryByDuration(receipts: Array<RunReceipt>): Array<DurationBucket> {
  const buckets = durationBuckets.map((bucket) => ({ delivered: 0, label: bucket.label, runs: 0 }));
  for (const receipt of receipts) {
    const minutes = (Date.parse(receipt.endedAt) - Date.parse(receipt.startedAt)) / 60_000;
    if (receipt.review !== undefined || Number.isNaN(minutes)) {
      continue;
    }
    const bucket = buckets[durationBuckets.findIndex((candidate) => minutes < candidate.maxMinutes)];
    if (bucket === undefined) {
      continue;
    }
    bucket.runs += 1;
    if (settlementOf(receipt) === "delivered") {
      bucket.delivered += 1;
    }
  }
  return buckets;
}

/** @internal */
export function landingLags(receipts: Array<RunReceipt>): Array<LandingLag> {
  const deliveredAt = deliveryTimes(receipts);
  const lags: Array<LandingLag> = [];
  for (const receipt of receipts) {
    const delivered = landedPullRequest(receipt) === undefined ? undefined : deliveredAt.get(String(receipt.review));
    if (delivered !== undefined) {
      lags.push({ minutes: (Date.parse(receipt.endedAt) - delivered) / 60_000, pullRequest: String(receipt.review) });
    }
  }
  return lags.toSorted((left, right) => left.minutes - right.minutes);
}

/** @internal */
export function isFlagged(receipt: RunReceipt): boolean {
  if (receipt.stopReason !== "completed") {
    return true;
  }
  return (receipt.review === undefined ? receipt.prUrl : receipt.decision) === undefined;
}

/** @internal */
export function summarizeDays(receipts: Array<RunReceipt>): Array<DaySummary> {
  const byDay = new Map<string, Array<RunReceipt>>();
  for (const receipt of receipts) {
    const day = receipt.startedAt.slice(0, 10);
    const runs = byDay.get(day) ?? [];
    runs.push(receipt);
    byDay.set(day, runs);
  }
  return [...byDay]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([day, runs]) => summarizeDay(day, runs));
}

function decisionLines(table: Map<string, Map<string, number>>, label: (key: string) => string): Array<string> {
  if (table.size === 0) {
    return ["  none recorded"];
  }
  return [...table].map(
    ([key, row]) =>
      `  ${label(key).padEnd(16)} ${[...row].map(([decision, count]) => `${decision} ${String(count)}`).join("  ")}`,
  );
}

export function formatReport(receipts: Array<RunReceipt>): string {
  const lines: Array<string> = [];
  for (const summary of summarizeDays(receipts)) {
    lines.push(
      `${summary.day}: ${String(summary.runs)} runs, ${String(summary.prs)} PRs, $${summary.costUsd.toFixed(2)}`,
      ...[...summary.stopReasons]
        .toSorted(([, left], [, right]) => right - left)
        .map(([reason, count]) => `  ${reason.padEnd(24)} ${String(count)}`),
      ...summary.flagged.map(
        (receipt) =>
          `  ! ${receipt.slot} ${receipt.bead ?? "-"} ${receipt.stopReason} commits=${String(receipt.commits)} ${receipt.transcriptDir}`,
      ),
    );
  }
  lines.push(
    "",
    "review decisions by baseline",
    ...decisionLines(decisionsBy(receipts, "baseline"), (key) => key.slice(0, 9)),
    "",
    "review decisions by kit",
    ...decisionLines(decisionsBy(receipts, "kit"), (key) => key),
    "",
    "review decisions by model",
    ...decisionLines(decisionsBy(receipts, "model"), (key) => key),
    "",
    "task runs delivered by duration",
    ...deliveryByDuration(receipts).map(
      (bucket) => `  ${bucket.label.padEnd(12)} ${String(bucket.delivered)}/${String(bucket.runs)}`,
    ),
    "",
    "delivered to merged (gatekeeper landings)",
    ...landingLagLines(landingLags(receipts)),
  );
  return lines.join("\n");
}

function landingLagLines(lags: Array<LandingLag>): Array<string> {
  if (lags.length === 0) {
    return ["  none recorded"];
  }
  return [
    `  ${String(lags.length)} landing(s)  median ${lagMinutes(percentile(lags, 0.5))}  p90 ${lagMinutes(percentile(lags, 0.9))}`,
    `  longest      #${lags.at(-1)?.pullRequest ?? "-"} at ${lagMinutes(lags.at(-1)?.minutes ?? 0)}`,
  ];
}

function deliveryTimes(receipts: Array<RunReceipt>): Map<string, number> {
  const deliveredAt = new Map<string, number>();
  for (const receipt of receipts) {
    const pullRequest =
      receipt.review === undefined && receipt.prUrl !== undefined ? prNumberFromUrl(receipt.prUrl) : undefined;
    if (pullRequest === undefined) {
      continue;
    }
    const at = Date.parse(receipt.endedAt);
    deliveredAt.set(pullRequest, Math.min(deliveredAt.get(pullRequest) ?? at, at));
  }
  return deliveredAt;
}

function landedPullRequest(receipt: RunReceipt): number | undefined {
  return receipt.review !== undefined && mergeDecisions.has(receipt.decision ?? "") ? receipt.review : undefined;
}

function lagMinutes(minutes: number): string {
  if (minutes < 60) {
    return `${String(Math.round(minutes))}m`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? `${String(hours)}h${String(Math.round(minutes % 60)).padStart(2, "0")}m`
    : `${String(Math.round(minutes / 1440))}d`;
}

function percentile(lags: Array<LandingLag>, fraction: number): number {
  const rank = Math.max(0, Math.ceil(fraction * lags.length) - 1);
  return lags[rank]?.minutes ?? 0;
}

export function formatSlugBlock(repoRoot: string, nowMs: number): string {
  const file = agentRunsPath(repoRoot, "signals.md");
  const document = existsSync(file) ? readFileSync(file, "utf8") : "";
  const recency = slugRecency(document);
  const bytes = new TextEncoder().encode(slugBlockLines(knownSlugsIn(document)).join("\n")).length;
  return [
    "",
    `brief slug block: ${String(recency.length)} slugs, ~${String(Math.round(bytes / 4))} tokens`,
    ...recency.map(
      (entry) =>
        `  ${entry.slug.padEnd(40)} x${String(entry.count).padEnd(4)}${entry.count > 1 ? "recurring" : "once     "}  last ${lastSeen(entry.lastSighted, nowMs)}`,
    ),
  ].join("\n");
}

function lastSeen(date: string | undefined, nowMs: number): string {
  if (date === undefined) {
    return "undated";
  }
  return `${date} (${String(Math.floor((nowMs - Date.parse(date)) / dayMs))}d ago)`;
}

function summarizeDay(day: string, runs: Array<RunReceipt>): DaySummary {
  const stopReasons = new Map<string, number>();
  const prs = new Set<string>();
  let costUsd = 0;
  for (const receipt of runs) {
    stopReasons.set(receipt.stopReason, (stopReasons.get(receipt.stopReason) ?? 0) + 1);
    costUsd += receipt.costUsd ?? 0;
    if (receipt.review === undefined && receipt.prUrl !== undefined) {
      prs.add(receipt.prUrl);
    }
  }
  return {
    costUsd,
    day,
    flagged: runs.filter((receipt) => isFlagged(receipt)),
    prs: prs.size,
    runs: runs.length,
    stopReasons,
  };
}
