import { describe, expect, it } from "vitest";

import type { RunReceipt } from "#src/run/receipts.ts";

import {
  attendedStopReason,
  classifyProbe,
  DEAD_MISS_LIMIT,
  lastResultSubtype,
  lastResultTerminalReason,
  nextMisses,
  receiptLine,
  resultMetrics,
  runModel,
  runOutput,
  settlementOf,
  stopReasonFor,
} from "#src/run/receipts.ts";

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

describe("receiptLine", () => {
  it("drops absent optional fields instead of writing null", () => {
    const receipt: RunReceipt = {
      branch: "feat/thing",
      endedAt: "2026-07-10T04:01:00.000Z",
      slot: "kiln-1",
      startedAt: "2026-07-10T04:00:00.000Z",
      stopReason: "completed",
      transcriptDir: "transcripts/kiln-1-x",
    };
    const line = receiptLine(receipt);
    expect(line).not.toContain("bead");
    expect(line).not.toContain("prUrl");
    expect(JSON.parse(line)).toEqual(receipt);
  });
});

function settled(overrides: Partial<RunReceipt>): RunReceipt {
  return {
    branch: "feat/x",
    endedAt: "2026-07-10T09:00:00.000Z",
    slot: "kiln-1",
    startedAt: "2026-07-10T08:00:00.000Z",
    stopReason: "completed",
    transcriptDir: "transcripts/kiln-1-x",
    ...overrides,
  };
}

describe("settlementOf", () => {
  const prUrl = "https://github.com/acme/sample/pull/10";

  it("calls a run delivered only when it completed with commits and a PR", () => {
    expect(settlementOf(settled({ commits: 1, prUrl }))).toBe("delivered");
  });

  it("calls a completed run that left nothing durable abandoned", () => {
    expect(settlementOf(settled({ commits: 0, prUrl }))).toBe("abandoned");
    expect(settlementOf(settled({ commits: 3 }))).toBe("abandoned");
    expect(settlementOf(settled({}))).toBe("abandoned");
  });

  it("separates a deliberate abort from every other way a run dies", () => {
    expect(settlementOf(settled({ stopReason: "signalled:SIGINT" }))).toBe("aborted");
    expect(settlementOf(settled({ stopReason: "crashed:no-result-event" }))).toBe("failed");
    expect(settlementOf(settled({ stopReason: "failed:api_error" }))).toBe("failed");
    expect(settlementOf(settled({ stopReason: "failed:exit:1" }))).toBe("failed");
  });

  it("does not call an aborted run delivered just because it left a PR", () => {
    expect(settlementOf(settled({ commits: 1, prUrl, stopReason: "signalled:SIGINT" }))).toBe("aborted");
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

function withOutput(structured: unknown): string {
  return [
    '{"type":"system","subtype":"init"}',
    JSON.stringify({
      structured_output: structured,
      subtype: "success",
      type: "result",
    }),
  ].join("\n");
}

describe("runOutput", () => {
  it("reads the signals and PR url the run stated", () => {
    const stream = withOutput({
      prUrl: "https://github.com/acme/sample/pull/8",
      signals: [
        { note: "the smoke test failed once then passed on retry", slug: "flaky-smoke" },
        { note: "the contributor doc still names a script that is gone", slug: "stale-doc" },
      ],
    });
    expect(runOutput(stream)).toEqual({
      prUrl: "https://github.com/acme/sample/pull/8",
      signals: [
        { note: "the smoke test failed once then passed on retry", slug: "flaky-smoke" },
        { note: "the contributor doc still names a script that is gone", slug: "stale-doc" },
      ],
    });
  });

  it("leaves a PR url the run merely mentioned in prose out of the receipt", () => {
    const stream = [
      '{"type":"user","message":"gh pr list said https://github.com/acme/sample/pull/3"}',
      JSON.stringify({
        result: "Opened https://github.com/acme/sample/pull/3? No, I only read it.",
        structured_output: { signals: [] },
        subtype: "success",
        type: "result",
      }),
    ].join("\n");
    expect(runOutput(stream)).toEqual({ signals: [] });
  });

  it("rejects a PR url outside this repo", () => {
    const stream = withOutput({
      prUrl: "https://github.com/someone/else/pull/8",
      signals: [],
    });
    expect(runOutput(stream)).toEqual({ signals: [] });
  });

  it("drops signals with a malformed slug or an empty note", () => {
    const stream = withOutput({
      signals: [
        { note: "nope", slug: "Not A Slug" },
        { note: "nope", slug: "bad_underscore" },
        { note: " ", slug: "empty-note" },
        { note: "kept", slug: "good-slug" },
      ],
    });
    expect(runOutput(stream)).toEqual({
      signals: [{ note: "kept", slug: "good-slug" }],
    });
  });

  it("reads a review's decision and drops one outside the set", () => {
    expect(runOutput(withOutput({ decision: "escalated", signals: [] }))).toEqual({
      decision: "escalated",
      signals: [],
    });
    expect(runOutput(withOutput({ decision: "approved", signals: [] }))).toEqual({ signals: [] });
  });

  it("is empty when the run died before stating anything", () => {
    expect(runOutput('{"type":"assistant"}\n')).toEqual({ signals: [] });
    expect(runOutput('{"type":"result","subtype":"error_during_execution"}')).toEqual({ signals: [] });
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

describe("classifyProbe", () => {
  it("parses an exit marker off an ended line", () => {
    expect(classifyProbe("ended 0")).toEqual({ kind: "ended", markerExit: 0 });
    expect(classifyProbe("ended 137")).toEqual({
      kind: "ended",
      markerExit: 137,
    });
  });

  it("reads a non-numeric or missing exit code as undefined", () => {
    expect(classifyProbe("ended")).toEqual({
      kind: "ended",
      markerExit: undefined,
    });
    expect(classifyProbe("ended oops")).toEqual({
      kind: "ended",
      markerExit: undefined,
    });
  });

  it("classifies a live, dead, and unreachable probe", () => {
    expect(classifyProbe("running")).toEqual({ kind: "running" });
    expect(classifyProbe("dead")).toEqual({ kind: "dead" });
    expect(classifyProbe(undefined)).toEqual({ kind: "unreachable" });
  });

  it("treats any other guest chatter as still running, never a miss", () => {
    expect(classifyProbe("")).toEqual({ kind: "running" });
    expect(classifyProbe("bash: pgrep: not found")).toEqual({
      kind: "running",
    });
  });
});

describe("nextMisses", () => {
  it("advances the tally only on a dead probe", () => {
    expect(nextMisses(0, "dead")).toBe(1);
    expect(nextMisses(1, "dead")).toBe(DEAD_MISS_LIMIT);
  });

  it("resets the tally on a live or unreachable probe", () => {
    expect(nextMisses(1, "running")).toBe(0);
    expect(nextMisses(1, "unreachable")).toBe(0);
  });

  it("counts crashed only on two consecutive dead probes, a live one breaking the run", () => {
    let misses = nextMisses(0, "dead");
    expect(misses).toBeLessThan(DEAD_MISS_LIMIT);
    misses = nextMisses(misses, "running");
    misses = nextMisses(misses, "dead");
    expect(misses).toBeLessThan(DEAD_MISS_LIMIT);
    misses = nextMisses(misses, "dead");
    expect(misses).toBe(DEAD_MISS_LIMIT);
  });
});

describe("attendedStopReason", () => {
  it("classifies from claude's exit code (no result event exists)", () => {
    expect(attendedStopReason(0, undefined)).toBe("completed");
    expect(attendedStopReason(130, undefined)).toBe("failed:exit:130");
  });

  it("flags a deliberate abort and a session that died before the marker", () => {
    expect(attendedStopReason(undefined, "SIGINT")).toBe("signalled:SIGINT");
    expect(attendedStopReason(undefined, undefined)).toBe("crashed:no-exit-marker");
  });
});

describe("stopReasonFor", () => {
  it("classifies from the result subtype with the exit code corroborating", () => {
    expect(stopReasonFor(0, undefined, "success", "completed")).toBe("completed");
    expect(stopReasonFor(1, undefined, "error_max_turns", undefined)).toBe("failed:error_max_turns");
    expect(stopReasonFor(1, undefined, "success", undefined)).toBe("failed:success");
  });

  it("names the terminal reason when a death still reports subtype success", () => {
    expect(stopReasonFor(1, undefined, "success", "api_error")).toBe("failed:api_error");
    expect(stopReasonFor(1, undefined, "error_max_turns", "max_turns")).toBe("failed:max_turns");
  });

  it("flags a kill and a silent death distinctly", () => {
    expect(stopReasonFor(undefined, "SIGTERM", undefined, undefined)).toBe("signalled:SIGTERM");
    expect(stopReasonFor(1, undefined, undefined, undefined)).toBe("crashed:no-result-event");
  });
});
