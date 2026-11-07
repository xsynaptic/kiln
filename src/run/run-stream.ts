import { isPlainObject } from "remeda";

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

interface ToolSpan {
  end: number;
  start: number;
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

export function lastResultEvent(stream: string): Record<string, unknown> | undefined {
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
