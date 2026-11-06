import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";

import { lineScrubber, scrubSecrets } from "#src/shared/scrub.ts";

describe("scrubSecrets", () => {
  it("replaces every occurrence of every secret", () => {
    expect(scrubSecrets("a TOKEN b TOKEN c PAT", ["TOKEN", "PAT"])).toBe("a [redacted] b [redacted] c [redacted]");
  });

  it("redacts the whole of a secret that contains another, whichever is listed first", () => {
    expect(scrubSecrets("key xxxz end", ["xx", "xxxz"])).toBe("key [redacted] end");
    expect(scrubSecrets("key xxxz end", ["xxxz", "xx"])).toBe("key [redacted] end");
  });

  it("ignores empty secrets instead of exploding the text", () => {
    expect(scrubSecrets("abc", [""])).toBe("abc");
  });
});

describe("lineScrubber", () => {
  it("scrubs a secret split across chunk boundaries", () => {
    const scrubber = lineScrubber(["ghp_secretvalue"]);
    const out = scrubber.feed("GH_TOKEN=ghp_secr") + scrubber.feed("etvalue\nnext line\n");
    expect(out).toBe("GH_TOKEN=[redacted]\nnext line\n");
  });

  it("flushes and scrubs the unterminated tail", () => {
    const scrubber = lineScrubber(["hunter2"]);
    expect(scrubber.feed("password is hunter2")).toBe("");
    expect(scrubber.flush()).toBe("password is [redacted]");
  });
});

// None of these letters is in `[redacted]`, since a real token never hides inside the marker
const letters = fc.constantFrom("x", "y", "z");

// Secrets are trimmed one-line token files, so none holds a line break; only convention keeps one out of the middle
const singleLineSecret = fc.array(letters, { maxLength: 4, minLength: 2 }).map((parts) => parts.join(""));

const secretCut = fc.tuple(fc.nat(), fc.nat(), fc.nat());

const secretList = fc
  .tuple(fc.array(singleLineSecret, { maxLength: 3, minLength: 1 }), fc.array(secretCut))
  .map(([secrets, cuts]) => [
    ...secrets,
    ...cuts
      .map(([pick, start, length]) => {
        const source = secrets[pick % secrets.length] ?? "";
        const from = start % source.length;
        return source.slice(from, from + 2 + (length % 3));
      })
      .filter((cut) => cut.length >= 2),
  ]);

function transcriptOf(secrets: Array<string>) {
  return fc
    .array(fc.oneof(fc.constantFrom(...secrets), letters, fc.constantFrom(" ", "\n")), { maxLength: 8 })
    .map((parts) => parts.join(""));
}

const scrubCase = secretList.chain((secrets) => fc.tuple(transcriptOf(secrets), fc.constant(secrets)));

describe("scrubbing over any transcript", () => {
  test.prop([scrubCase, fc.array(fc.nat({ max: 40 }), { maxLength: 6 })])(
    "gives the same output however the stream is chunked",
    ([text, secrets], cuts) => {
      const scrubber = lineScrubber(secrets);
      const bounds = [
        0,
        ...cuts.map((cut) => Math.min(cut, text.length)).toSorted((left, right) => left - right),
        text.length,
      ];
      let streamed = "";
      const starts = bounds.slice(0, -1);
      for (const [index, start] of starts.entries()) {
        streamed += scrubber.feed(text.slice(start, bounds[index + 1]));
      }
      expect(streamed + scrubber.flush()).toBe(scrubSecrets(text, secrets));
    },
  );

  test.prop([scrubCase])("leaves no secret in the output", ([text, secrets]) => {
    const scrubbed = scrubSecrets(text, secrets);
    for (const secret of secrets) {
      expect(scrubbed).not.toContain(secret);
    }
  });

  test.prop([scrubCase])("does not depend on the order secrets are listed in", ([text, secrets]) => {
    expect(scrubSecrets(text, secrets.toReversed())).toBe(scrubSecrets(text, secrets));
  });
});
