import { isPlainObject } from "remeda";
import { z } from "zod";

import { kilnConfig } from "../config/config.ts";
import { parseJson } from "../shared/lenient-json.ts";

export interface ResultMetrics {
  apiErrorStatus?: number;
  apiMs?: number;
  costUsd?: number;
  numTurns?: number;
  rateLimitEvents?: number;
  toolMs?: number;
  ttftMs?: number;
}

const reviewDecisions = ["merged", "fixed-and-merged", "escalated", "nothing-to-land"] as const;

export type ReviewDecision = (typeof reviewDecisions)[number];

export interface RunOutput {
  decision?: ReviewDecision;
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

interface ToolSpan {
  end: number;
  start: number;
}

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

export function lastResultSubtype(stream: string): string | undefined {
  const event = lastResultEvent(stream);
  return typeof event?.subtype === "string" ? event.subtype : undefined;
}

// The subtype can say "success" even when the API killed the run mid-response
export function lastResultTerminalReason(stream: string): string | undefined {
  const event = lastResultEvent(stream);
  return typeof event?.terminal_reason === "string" ? event.terminal_reason : undefined;
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

export function resultMetrics(stream: string): ResultMetrics {
  const event = lastResultEvent(stream);
  const metrics: ResultMetrics = {};
  const apiMs = resultNumber(event, "duration_api_ms");
  if (apiMs !== undefined) {
    metrics.apiMs = apiMs;
  }
  const ttftMs = resultNumber(event, "ttft_ms");
  if (ttftMs !== undefined) {
    metrics.ttftMs = ttftMs;
  }
  const numTurns = resultNumber(event, "num_turns");
  if (numTurns !== undefined) {
    metrics.numTurns = numTurns;
  }
  const rateLimitEvents = countRateLimitEvents(stream);
  if (rateLimitEvents > 0) {
    metrics.rateLimitEvents = rateLimitEvents;
  }
  const apiErrorStatus = resultNumber(event, "api_error_status");
  if (apiErrorStatus !== undefined) {
    metrics.apiErrorStatus = apiErrorStatus;
  }
  const costUsd = resultNumber(event, "total_cost_usd");
  if (costUsd !== undefined) {
    metrics.costUsd = Math.round(costUsd * 10_000) / 10_000;
  }
  const toolMs = toolWallMs(stream);
  if (toolMs > 0) {
    metrics.toolMs = toolMs;
  }
  return metrics;
}

export function runModel(transcript: string): string | undefined {
  for (const event of jsonLines(transcript)) {
    const model = eventModel(event);
    if (model !== undefined) {
      return model;
    }
  }
  return undefined;
}

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

function contentBlocks(event: unknown): Array<Record<string, unknown>> {
  if (!isPlainObject(event) || !isPlainObject(event.message) || !Array.isArray(event.message.content)) {
    return [];
  }
  return event.message.content.filter(isPlainObject);
}

function countRateLimitEvents(stream: string): number {
  let count = 0;
  for (const line of stream.split("\n")) {
    if (!line.includes('"type":"rate_limit_event"')) {
      continue;
    }
    if (rateLimitStatus(parseJson(line)) !== "allowed") {
      count += 1;
    }
  }
  return count;
}

function eventModel(event: unknown): string | undefined {
  if (!isPlainObject(event)) {
    return undefined;
  }
  const { message, model, type } = event;
  if (type === "system") {
    return namedModel(model);
  }
  return type === "assistant" ? messageModel(message) : undefined;
}

function messageModel(message: unknown): string | undefined {
  if (!isPlainObject(message)) {
    return undefined;
  }
  return namedModel(message.model);
}

function eventTimeMs(event: unknown): number | undefined {
  if (!isPlainObject(event) || typeof event.timestamp !== "string") {
    return undefined;
  }
  const at = Date.parse(event.timestamp);
  return Number.isNaN(at) ? undefined : at;
}

function lastResultEvent(stream: string): Record<string, unknown> | undefined {
  let result: Record<string, unknown> | undefined;
  for (const event of jsonLines(stream)) {
    if (isPlainObject(event) && event.type === "result") {
      result = event;
    }
  }
  return result;
}

// Claude Code marks its own error turns `<synthetic>`, which is not a model name
function namedModel(value: unknown): string | undefined {
  return typeof value === "string" && !value.startsWith("<") ? value : undefined;
}

function rateLimitStatus(event: unknown): string | undefined {
  if (!isPlainObject(event) || !isPlainObject(event.rate_limit_info)) {
    return undefined;
  }
  const { status } = event.rate_limit_info;
  return typeof status === "string" ? status : undefined;
}

function readDecision(claimed: unknown): ReviewDecision | undefined {
  if (!isPlainObject(claimed)) {
    return undefined;
  }
  const { decision: claimedDecision } = claimed;
  return reviewDecisions.find((decision) => decision === claimedDecision);
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

function resultNumber(event: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = event?.[key];
  return typeof value === "number" ? value : undefined;
}

function toolSpans(stream: string): Array<ToolSpan> {
  const opened = new Map<string, number>();
  const spans: Array<ToolSpan> = [];
  for (const event of jsonLines(stream)) {
    const at = eventTimeMs(event);
    if (at === undefined) {
      continue;
    }
    spans.push(...spansClosedBy(event, at, opened));
  }
  return spans;
}

function spansClosedBy(event: unknown, at: number, opened: Map<string, number>): Array<ToolSpan> {
  const closed: Array<ToolSpan> = [];
  for (const block of contentBlocks(event)) {
    if (block.type === "tool_use" && typeof block.id === "string") {
      opened.set(block.id, at);
      continue;
    }
    if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
      continue;
    }
    const start = opened.get(block.tool_use_id);
    if (start === undefined) {
      continue;
    }
    closed.push({ end: at, start });
    opened.delete(block.tool_use_id);
  }
  return closed;
}

function toolWallMs(stream: string): number {
  const spans = toolSpans(stream).toSorted((left, right) => left.start - right.start);
  let total = 0;
  let start = 0;
  let end = 0;
  for (const span of spans) {
    if (span.start > end) {
      total += end - start;
      start = span.start;
      end = span.end;
    } else if (span.end > end) {
      end = span.end;
    }
  }
  return total + (end - start);
}

function* jsonLines(stream: string): Generator {
  for (const line of stream.split("\n")) {
    if (!line.startsWith("{")) {
      continue;
    }

    const event = parseJson(line);
    if (event !== undefined) {
      yield event;
    }
  }
}
