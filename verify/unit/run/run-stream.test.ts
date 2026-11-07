import { describe, expect, it } from "vitest";

import { lastResultSubtype, lastResultTerminalReason, resultMetrics, runModel } from "#src/run/run-stream.ts";

function toolResult(timestamp: string, ...ids: Array<string>): string {
  return JSON.stringify({
    message: {
      content: ids.map((id) => ({ tool_use_id: id, type: "tool_result" })),
    },
    timestamp,
    type: "user",
  });
}

function toolUse(timestamp: string, ...ids: Array<string>): string {
  return JSON.stringify({
    message: { content: ids.map((id) => ({ id, name: "Bash", type: "tool_use" })) },
    timestamp,
    type: "assistant",
  });
}

describe("resultMetrics", () => {
  const resultEvent = JSON.stringify({
    duration_api_ms: 2_020_602,
    num_turns: 13,
    subtype: "success",
    ttft_ms: 70_220,
    type: "result",
  });

  it("promotes api time, ttft, and turns from the final result event", () => {
    expect(resultMetrics(resultEvent)).toEqual({
      apiMs: 2_020_602,
      numTurns: 13,
      ttftMs: 70_220,
    });
  });

  const rateLimitPing = (status: string): string =>
    JSON.stringify({
      rate_limit_info: { status },
      type: "rate_limit_event",
    });

  it("counts rate-limit events and includes the tally only when nonzero", () => {
    const withLimits = [rateLimitPing("allowed_warning"), rateLimitPing("allowed_warning"), resultEvent].join("\n");
    expect(resultMetrics(withLimits).rateLimitEvents).toBe(2);
    expect("rateLimitEvents" in resultMetrics(resultEvent)).toBe(false);
  });

  it("ignores the routine allowed pings every turn emits", () => {
    const quiet = [rateLimitPing("allowed"), rateLimitPing("allowed"), resultEvent].join("\n");
    expect("rateLimitEvents" in resultMetrics(quiet)).toBe(false);
  });

  it("counts a ping whose shape it cannot read", () => {
    const malformed = [JSON.stringify({ type: "rate_limit_event" }), resultEvent].join("\n");
    expect(resultMetrics(malformed).rateLimitEvents).toBe(1);
  });

  it("promotes the api error status and drops the null a clean run carries", () => {
    const failed = JSON.stringify({
      api_error_status: 500,
      subtype: "success",
      terminal_reason: "api_error",
      type: "result",
    });
    const dropped = '{"api_error_status":null,"subtype":"success","terminal_reason":"api_error","type":"result"}';
    expect(resultMetrics(failed).apiErrorStatus).toBe(500);
    expect("apiErrorStatus" in resultMetrics(dropped)).toBe(false);
  });

  it("promotes the run's cost, rounded past the float noise it arrives with", () => {
    const priced = JSON.stringify({
      subtype: "success",
      total_cost_usd: 12.34567891,
      type: "result",
    });
    expect(resultMetrics(priced).costUsd).toBe(12.3457);
    expect("costUsd" in resultMetrics(resultEvent)).toBe(false);
  });

  it("adds up the time between each tool call and its result", () => {
    const stream = [
      toolUse("2026-07-28T09:00:00.000Z", "one"),
      toolResult("2026-07-28T09:00:10.000Z", "one"),
      toolUse("2026-07-28T09:00:20.000Z", "two"),
      toolResult("2026-07-28T09:00:25.000Z", "two"),
      resultEvent,
    ].join("\n");
    expect(resultMetrics(stream).toolMs).toBe(15_000);
  });

  it("merges concurrent calls instead of summing them past the wall clock", () => {
    const stream = [
      toolUse("2026-07-28T09:00:00.000Z", "one", "two"),
      toolResult("2026-07-28T09:00:06.000Z", "two"),
      toolResult("2026-07-28T09:00:10.000Z", "one"),
      resultEvent,
    ].join("\n");
    expect(resultMetrics(stream).toolMs).toBe(10_000);
  });

  it("contributes nothing for a call the run died inside of", () => {
    const stream = [toolUse("2026-07-28T09:00:00.000Z", "one")].join("\n");
    expect("toolMs" in resultMetrics(stream)).toBe(false);
  });

  it("returns an empty object when the run emitted no result event", () => {
    expect(resultMetrics('{"type":"assistant"}')).toEqual({});
  });
});

describe("lastResultSubtype", () => {
  it("finds the last result event and skips non-JSON noise", () => {
    const stream = [
      "some warning line",
      "1752033600000",
      '{"type":"system","subtype":"init"}',
      '{"type":"result","subtype":"error_during_execution"}',
      '{"type":"result","subtype":"success","total_cost_usd":0}',
    ].join("\n");
    expect(lastResultSubtype(stream)).toBe("success");
  });

  it("is undefined when the run died before emitting one", () => {
    expect(lastResultSubtype('{"type":"assistant"}\n')).toBeUndefined();
  });
});

describe("lastResultTerminalReason", () => {
  it("reads terminal_reason off the last result event", () => {
    const stream = [
      '{"type":"system","subtype":"init"}',
      '{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error"}',
    ].join("\n");
    expect(lastResultTerminalReason(stream)).toBe("api_error");
  });

  it("is undefined when the event carries none", () => {
    expect(lastResultTerminalReason('{"type":"result","subtype":"success"}\n')).toBeUndefined();
  });
});

describe("runModel", () => {
  it("reads the model off the stream's init event, ahead of any subagent's turns", () => {
    const stream = [
      '{"type":"system","subtype":"init","model":"claude-opus-5"}',
      '{"type":"assistant","parent_tool_use_id":"toolu_1","message":{"model":"claude-haiku-4-5"}}',
    ].join("\n");
    expect(runModel(stream)).toBe("claude-opus-5");
  });

  it("falls back to a session transcript's first real assistant turn", () => {
    const session = [
      '{"type":"user","message":{"content":"go"}}',
      '{"type":"assistant","message":{"model":"<synthetic>"}}',
      '{"type":"assistant","message":{"model":"claude-sonnet-5"}}',
    ].join("\n");
    expect(runModel(session)).toBe("claude-sonnet-5");
  });

  it("is undefined when nothing names a model", () => {
    expect(runModel('{"type":"result","subtype":"success"}\n')).toBeUndefined();
  });
});
