import { describe, expect, it } from "vitest";

import { wrapupSettings } from "#src/run/wrapup-nudge.ts";

describe("wrapupSettings", () => {
  it("registers the hook on PostToolUse for every tool", () => {
    const settings: unknown = JSON.parse(wrapupSettings("/work/wrapup-hook.mjs", "/work/blind-nudged"));
    expect(settings).toStrictEqual({
      hooks: {
        PostToolUse: [
          {
            hooks: [
              {
                command: "node /work/wrapup-hook.mjs /work/blind-nudged",
                timeout: 10,
                type: "command",
              },
            ],
            matcher: "*",
          },
        ],
      },
    });
  });
});
