import { fc, test } from "@fast-check/vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { beforeEach, describe, expect, it } from "vitest";

import { bumpSignals, knownSlugs, slugRecency } from "#src/run/signals.ts";
import { agentRunsPath } from "#src/shared/run-artifacts.ts";

const header = "# Signals\n\nQueue, not a record.\n";

function seedSignals(document: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "signals-test-"));
  mkdirSync(agentRunsPath(root), { recursive: true });
  writeFileSync(agentRunsPath(root, "signals.md"), document);
  return root;
}

describe("knownSlugs", () => {
  beforeEach(() => {
    delete process.env.KILN_RUNS_DIR;
  });

  it("lists what is on file, most-sighted first, each with its first sighting's gist", () => {
    const root = seedSignals(
      `${header}\n## rare-thing (x1)\n\n- 2026-07-25 run-a | it happened once\n\n## common-thing (x4)\n\n- 2026-07-21 run-b | the gate printed noise\n- 2026-07-22 run-c | a later sighting in other words\n`,
    );
    expect(knownSlugs(root)).toEqual([
      { gist: "the gate printed noise", slug: "common-thing" },
      { gist: "it happened once", slug: "rare-thing" },
    ]);
  });

  it("caps a long gist so a full queue still leaves the brief readable", () => {
    const root = seedSignals(`${header}\n## wordy (x1)\n\n- 2026-07-25 run-a | ${"word ".repeat(40)}\n`);
    const gist = knownSlugs(root)[0]?.gist ?? "";
    expect(gist.length).toBeLessThanOrEqual(113);
    expect(gist.endsWith("...")).toBe(true);
  });

  it("is empty before any run has filed one", () => {
    const root = mkdtempSync(path.join(tmpdir(), "signals-test-"));
    expect(knownSlugs(root)).toEqual([]);
  });
});

describe("bumpSignals", () => {
  it("opens a new section with a count of one and a dated sighting", () => {
    const result = bumpSignals(
      header,
      [{ note: "the smoke test failed once then passed", slug: "flaky-smoke" }],
      "kiln-2-20260721T120000",
      "2026-07-21",
    );
    expect(result).toBe(
      `${header}\n## flaky-smoke (x1)\n\n- 2026-07-21 kiln-2-20260721T120000 | the smoke test failed once then passed\n`,
    );
  });

  it("bumps an existing slug's count and appends the sighting to its section", () => {
    const once = bumpSignals(header, [{ note: "first sighting", slug: "flaky-smoke" }], "run-a", "2026-07-20");
    const twice = bumpSignals(once, [{ note: "seen again", slug: "flaky-smoke" }], "run-b", "2026-07-21");
    expect(twice).toContain("## flaky-smoke (x2)");
    expect(twice).toContain("- 2026-07-20 run-a | first sighting\n- 2026-07-21 run-b | seen again");
  });

  it("keeps sightings inside their own section when several slugs exist", () => {
    let document = header;
    document = bumpSignals(document, [{ note: "a", slug: "first-slug" }], "run-a", "2026-07-20");
    document = bumpSignals(document, [{ note: "b", slug: "second-slug" }], "run-a", "2026-07-20");
    document = bumpSignals(document, [{ note: "a again", slug: "first-slug" }], "run-b", "2026-07-21");
    expect(document).toBe(
      `${header}\n## first-slug (x2)\n\n- 2026-07-20 run-a | a\n- 2026-07-21 run-b | a again\n\n## second-slug (x1)\n\n- 2026-07-20 run-a | b\n`,
    );
  });

  it("handles several signals from one run, including a repeated slug", () => {
    const result = bumpSignals(
      header,
      [
        { note: "first", slug: "repeat" },
        { note: "second", slug: "repeat" },
      ],
      "run-a",
      "2026-07-21",
    );
    expect(result).toContain("## repeat (x2)");
    expect(result).toContain("- 2026-07-21 run-a | first\n- 2026-07-21 run-a | second");
  });
});

describe("slugRecency", () => {
  it("reads each slug's count and its latest sighting, most-sighted first", () => {
    const document = [
      header,
      "## once-only (x1)",
      "",
      "- 2026-09-01 kiln-1-a | a note",
      "",
      "## recurring (x2)",
      "",
      "- 2026-09-10 kiln-2-c | again",
      "- 2026-08-20 kiln-1-b | first",
      "",
    ].join("\n");
    expect(slugRecency(document)).toEqual([
      { count: 2, lastSighted: "2026-09-10", slug: "recurring" },
      { count: 1, lastSighted: "2026-09-01", slug: "once-only" },
    ]);
  });
});

const slugs = ["flaky-smoke", "stale-doc", "slow-gate"] as const;

// `readSignal` trims each note and drops an empty one before a signal reaches the file
const noteFragment = fc.oneof(
  fc.constantFrom("gate", " ", "\n", "\r\n", "\u{2028}", "## ", " (x", "9", ")", "| ", "- 2026-07-21 "),
  fc.tuple(fc.constantFrom(...slugs), fc.nat({ max: 12 })).map(([slug, count]) => `\n## ${slug} (x${String(count)})`),
);

const runNote = fc
  .array(noteFragment, { maxLength: 6, minLength: 1 })
  .map((parts) => parts.join("").trim())
  .filter((note) => note.length > 0);

const runSignal = fc.record({ note: runNote, slug: fc.constantFrom(...slugs) });

describe("bumpSignals over any notes", () => {
  it("keeps a note that holds a heading line from forging that section", () => {
    const forged = bumpSignals(
      header,
      [
        { note: "## flaky-smoke (x0)\n## flaky-smoke (x0)", slug: "flaky-smoke" },
        { note: "gate", slug: "flaky-smoke" },
      ],
      "kiln-1-20260721T120000",
      "2026-07-21",
    );
    expect(slugRecency(forged)).toEqual([expect.objectContaining({ count: 2, slug: "flaky-smoke" })]);
  });

  test.prop([fc.array(runSignal, { maxLength: 8, minLength: 1 })])(
    "counts each sighting under its own slug and leaves every other count alone",
    (signals) => {
      const expected = new Map<string, number>();
      let document = header;
      for (const signal of signals) {
        document = bumpSignals(document, [signal], "kiln-1-20260721T120000", "2026-07-21");
        expected.set(signal.slug, (expected.get(signal.slug) ?? 0) + 1);
        const counts = new Map(slugRecency(document).map((entry) => [entry.slug, entry.count]));
        expect(counts).toEqual(expected);
      }
    },
  );
});
