import { describe, expect, it } from "vitest";

import { parseVmStates, singleQuote } from "#src/vm/vm.ts";

const LIST_JSON = [
  '{"name":"kiln-1","status":"Stopped","arch":"aarch64","cpus":4,"memory":8589934592,"disk":64424509440,"runtime":"docker"}',
  '{"name":"kiln-2","status":"Running","arch":"aarch64","cpus":4,"memory":8589934592,"disk":64424509440,"runtime":"docker"}',
].join("\n");

describe("parseVmStates", () => {
  it("reads a state per profile from colima's JSONL", () => {
    const states = parseVmStates(LIST_JSON);
    expect(states.get("kiln-1")).toBe("stopped");
    expect(states.get("kiln-2")).toBe("running");
  });

  it("leaves an unprovisioned profile absent rather than defaulting it", () => {
    expect(parseVmStates(LIST_JSON).has("kiln-7")).toBe(false);
  });

  it("survives empty output, blank lines, and a truncated record", () => {
    expect(parseVmStates("").size).toBe(0);
    expect(parseVmStates('\n{"name":"kiln-1","stat').size).toBe(0);
  });

  it("skips a status it does not model instead of guessing", () => {
    expect(parseVmStates('{"name":"kiln-1","status":"Broken"}').size).toBe(0);
  });
});

describe("singleQuote", () => {
  it("escapes embedded single quotes wherever they sit", () => {
    expect(singleQuote("")).toBe("''");
    expect(singleQuote("don't")).toBe(String.raw`'don'\''t'`);
    expect(singleQuote("it''s")).toBe(String.raw`'it'\'''\''s'`);
    expect(singleQuote("'lead")).toBe(String.raw`''\''lead'`);
    expect(singleQuote("trail'")).toBe(String.raw`'trail'\'''`);
  });

  it("leaves dollar signs and double quotes untouched", () => {
    expect(singleQuote('it\'s "$HOME"')).toBe(String.raw`'it'\''s "$HOME"'`);
  });
});
