import { isPlainObject } from "remeda";
import { z } from "zod";

import { kilnConfig } from "../config/config.ts";
import { lastResultEvent } from "./run-stream.ts";

const reviewDecisions = ["merged", "fixed-and-merged", "escalated", "nothing-to-land"] as const;

export type ReviewDecision = (typeof reviewDecisions)[number];

const runOutcomeKinds = ["no-change"] as const;

export interface RunOutcome {
  kind: (typeof runOutcomeKinds)[number];
  reason: string;
}

export interface RunOutput {
  decision?: ReviewDecision;
  outcome?: RunOutcome;
  prUrl?: string;
  signals: Array<RunSignal>;
}

export interface RunReceipt {
  apiErrorStatus?: number;
  apiMs?: number;
  baseline?: string;
  bead?: string;
  branch: string;
  claudeCode?: string;
  commits?: number;
  costUsd?: number;
  decision?: ReviewDecision;
  endedAt: string;
  exitCode?: number;
  kit?: string;
  mode?: "attended" | "watch";
  model?: string;
  nudge?: RunNudge;
  numTurns?: number;
  outcome?: RunOutcome;
  prUrl?: string;
  rateLimitEvents?: number;
  review?: number;
  signals?: Array<RunSignal>;
  slot: string;
  startedAt: string;
  stopReason: string;
  toolMs?: number;
  transcriptDir: string;
  ttftMs?: number;
}

export interface RunNudge {
  minutes?: number;
  tokens?: number;
  trigger: "both" | "time" | "tokens";
}

export interface RunSignal {
  note: string;
  slug: string;
}

const runSignalSchema = z.object({ note: z.string(), slug: z.string() }) satisfies z.ZodType<RunSignal>;

const runOutcomeSchema = z.object({
  kind: z.enum(runOutcomeKinds),
  reason: z.string().trim().min(1),
}) satisfies z.ZodType<RunOutcome>;

export const runNudgeSchema = z.object({
  minutes: z.number().exactOptional(),
  tokens: z.number().exactOptional(),
  trigger: z.enum(["both", "time", "tokens"]),
}) satisfies z.ZodType<RunNudge>;

// The ledger keeps every receipt ever written, so a new field must be optional or older lines fail to parse
export const runReceiptSchema = z.object({
  apiErrorStatus: z.number().exactOptional(),
  apiMs: z.number().exactOptional(),
  baseline: z.string().exactOptional(),
  bead: z.string().exactOptional(),
  branch: z.string(),
  claudeCode: z.string().exactOptional(),
  commits: z.number().exactOptional(),
  costUsd: z.number().exactOptional(),
  decision: z.enum(reviewDecisions).exactOptional(),
  endedAt: z.string(),
  exitCode: z.number().exactOptional(),
  kit: z.string().exactOptional(),
  mode: z.enum(["attended", "watch"]).exactOptional(),
  model: z.string().exactOptional(),
  nudge: runNudgeSchema.exactOptional(),
  numTurns: z.number().exactOptional(),
  outcome: runOutcomeSchema.exactOptional(),
  prUrl: z.string().exactOptional(),
  rateLimitEvents: z.number().exactOptional(),
  review: z.number().exactOptional(),
  signals: z.array(runSignalSchema).exactOptional(),
  slot: z.string(),
  startedAt: z.string(),
  stopReason: z.string(),
  toolMs: z.number().exactOptional(),
  transcriptDir: z.string(),
  ttftMs: z.number().exactOptional(),
}) satisfies z.ZodType<RunReceipt>;

export const deadMissLimit = 2;

export const runOutputSchema = JSON.stringify({
  additionalProperties: false,
  properties: {
    decision: {
      description:
        "Review runs only: what you did with the pull request. Omit it on any other run, and on a review that ended before deciding.",
      enum: [...reviewDecisions],
      type: "string",
    },
    outcome: {
      additionalProperties: false,
      description:
        "Task runs only: set it when the task needs no change at all (already done, superseded, or wrong as specified) and you made no commits and opened no PR. Omit it on every other run.",
      properties: {
        kind: { enum: [...runOutcomeKinds], type: "string" },
        reason: {
          description:
            "One line a human can act on, saying why the task needs no change. It becomes the reason the bead is parked.",
          minLength: 1,
          type: "string",
        },
      },
      required: ["kind", "reason"],
      type: "object",
    },
    prUrl: {
      description:
        "Full URL of the pull request you opened for this task. Omit it if you opened none, and never name one you merely read.",
      type: "string",
    },
    signals: {
      description:
        "Friction you hit around the work (a flaky test, a stale doc, missing tooling, a confusing seam), never the content or outcome of the task itself. Empty is the normal case.",
      items: {
        additionalProperties: false,
        properties: {
          note: {
            description: "One line: what you hit and where.",
            type: "string",
          },
          slug: {
            description:
              "Kebab-case dedupe key. Your brief lists the slugs already on file: reuse the exact one that covers what you hit, so repeat sightings count up instead of scattering.",
            type: "string",
          },
        },
        required: ["note", "slug"],
        type: "object",
      },
      type: "array",
    },
  },
  required: ["signals"],
  type: "object",
});

export type ProbeState =
  { kind: "dead" } | { kind: "ended"; markerExit: number | undefined } | { kind: "running" } | { kind: "unreachable" };

export type RunSettlement = "abandoned" | "aborted" | "delivered" | "failed";

export function attendedStopReason(exitCode: number | undefined, abortSignal: string | undefined): string {
  if (abortSignal !== undefined) {
    return `signalled:${abortSignal}`;
  }
  if (exitCode === undefined) {
    return "crashed:no-exit-marker";
  }
  if (exitCode === 0) {
    return "completed";
  }
  return `failed:exit:${String(exitCode)}`;
}

export function classifyProbe(probe: string | undefined): ProbeState {
  if (probe === undefined) {
    return { kind: "unreachable" };
  }
  if (probe.startsWith("ended")) {
    const marker = Number(probe.split(" ", 2)[1]);
    return { kind: "ended", markerExit: Number.isNaN(marker) ? undefined : marker };
  }
  if (probe === "dead") {
    return { kind: "dead" };
  }
  return { kind: "running" };
}

export function nextMisses(misses: number, kind: ProbeState["kind"]): number {
  return kind === "dead" ? misses + 1 : 0;
}

export function receiptLine(receipt: RunReceipt): string {
  return JSON.stringify(receipt);
}

const slugPattern = /^[a-z0-9][a-z0-9-]*$/;
const prUrlPattern = new RegExp(
  String.raw`^https://github\.com/${kilnConfig.identity.githubRepo.replaceAll(".", String.raw`\.`)}/pull/\d+$`,
);

export function runOutput(stream: string): RunOutput {
  const claimed = lastResultEvent(stream)?.structured_output;
  const output: RunOutput = { signals: readSignals(claimed) };
  const prUrl = readPrUrl(claimed);
  if (prUrl !== undefined) {
    output.prUrl = prUrl;
  }
  const decision = readDecision(claimed);
  if (decision !== undefined) {
    output.decision = decision;
  }
  const outcome = readOutcome(claimed);
  if (outcome !== undefined) {
    output.outcome = outcome;
  }
  return output;
}

export function settlementOf(receipt: RunReceipt): RunSettlement {
  if (receipt.stopReason.startsWith("signalled:")) {
    return "aborted";
  }
  if (receipt.stopReason !== "completed") {
    return "failed";
  }
  return receipt.prUrl !== undefined && (receipt.commits ?? 0) > 0 ? "delivered" : "abandoned";
}

// On failure the stop reason sets the label, because a run killed by an api_error still reports subtype "success"
export function stopReasonFor(
  exitCode: number | undefined,
  signal: string | undefined,
  resultSubtype: string | undefined,
  terminalReason: string | undefined,
): string {
  if (signal !== undefined) {
    return `signalled:${signal}`;
  }
  if (resultSubtype === undefined) {
    return "crashed:no-result-event";
  }
  if (resultSubtype === "success" && exitCode === 0) {
    return "completed";
  }
  if (terminalReason !== undefined && terminalReason !== "completed") {
    return `failed:${terminalReason}`;
  }
  return `failed:${resultSubtype}`;
}

function readDecision(claimed: unknown): ReviewDecision | undefined {
  if (!isPlainObject(claimed)) {
    return undefined;
  }
  const { decision: claimedDecision } = claimed;
  return reviewDecisions.find((decision) => decision === claimedDecision);
}

function readOutcome(claimed: unknown): RunOutcome | undefined {
  if (!isPlainObject(claimed)) {
    return undefined;
  }
  const outcome = runOutcomeSchema.safeParse(claimed.outcome);
  return outcome.success ? outcome.data : undefined;
}

// Only this repo's PRs count, or merging a PR elsewhere would close the bead
function readPrUrl(claimed: unknown): string | undefined {
  if (!isPlainObject(claimed)) {
    return undefined;
  }
  const { prUrl } = claimed;
  return typeof prUrl === "string" && prUrlPattern.test(prUrl) ? prUrl : undefined;
}

function readSignals(claimed: unknown): Array<RunSignal> {
  if (!isPlainObject(claimed)) {
    return [];
  }
  const entries: Array<unknown> = Array.isArray(claimed.signals) ? claimed.signals : [];
  const signals: Array<RunSignal> = [];
  for (const entry of entries) {
    const signal = readSignal(entry);
    if (signal !== undefined) {
      signals.push(signal);
    }
  }
  return signals;
}

// The slug is inserted into a regular expression, so it must stay kebab-case
function readSignal(entry: unknown): RunSignal | undefined {
  if (!isPlainObject(entry)) {
    return undefined;
  }
  const { note, slug } = entry;
  if (typeof note !== "string" || typeof slug !== "string") {
    return undefined;
  }
  const trimmed = note.trim();
  if (trimmed.length === 0 || !slugPattern.test(slug)) {
    return undefined;
  }
  return { note: trimmed, slug };
}
