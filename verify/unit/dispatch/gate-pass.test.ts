import { beforeEach, describe, expect, it, vi } from "vitest";

import { didCloseLandedBead, settleStrandedBeads } from "#src/dispatch/gate-pass.ts";
import { fetchPrState } from "#src/gatekeeper/pr-views.ts";
import { bd, bdJson, listGates } from "#src/queue/bd-client.ts";

vi.mock(import("#src/queue/bd-client.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  bd: vi.fn(() => ""),
  bdJson: vi.fn(),
  listGates: vi.fn(() => []),
}));
vi.mock(import("#src/gatekeeper/pr-views.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  fetchPrState: vi.fn(),
}));

const reason = "landed: PR #12 merged";
const parks = [
  { blocked: ["bd-1", "bd-2"], id: "bd-park-a" },
  { blocked: ["bd-3"], id: "bd-park-b" },
];

beforeEach(() => {
  vi.mocked(bd).mockReset().mockReturnValue("");
  vi.mocked(bdJson).mockReset();
  vi.mocked(listGates).mockReset().mockReturnValue([]);
  vi.mocked(fetchPrState).mockReset();
});

describe("didCloseLandedBead", () => {
  it("resolves only the parks holding the bead, then closes it", () => {
    expect(didCloseLandedBead("bd-1", reason, parks)).toBe(true);
    expect(vi.mocked(bd).mock.calls).toEqual([
      [["gate", "resolve", "bd-park-a", "--reason", reason]],
      [["close", "bd-1", "--reason", reason]],
    ]);
  });

  it("reports a refused close instead of throwing it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(bd).mockImplementation(() => {
      throw new Error("blocked by open gate");
    });
    expect(didCloseLandedBead("bd-3", reason, parks)).toBe(false);
    expect(warn).toHaveBeenCalledWith("  could not close bd-3: blocked by open gate");
    warn.mockRestore();
  });
});

describe("settleStrandedBeads", () => {
  const dependenciesByBead: Record<string, Array<Record<string, unknown>>> = {
    "bd-abandoned": [{ await_id: "7", await_type: "gh:pr", dependency_type: "blocks", status: "closed" }],
    "bd-landed": [{ await_id: "12", await_type: "gh:pr", dependency_type: "blocks", status: "closed" }],
  };

  beforeEach(() => {
    vi.mocked(bdJson).mockImplementation((args) => {
      if (args[0] === "list") {
        return [
          { assignee: "", id: "bd-landed" },
          { assignee: "", id: "bd-abandoned" },
          { assignee: "kiln-1", id: "bd-running" },
        ];
      }
      if (args[0] === "dep") {
        return dependenciesByBead[args[2] ?? ""] ?? [];
      }
      return [];
    });
    vi.mocked(fetchPrState).mockImplementation((prNumber) => (prNumber === 12 ? "MERGED" : "CLOSED"));
  });

  it("closes a bead whose PR merged and warns only about the one nothing will move", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    settleStrandedBeads(false, new Map());
    expect(vi.mocked(bd).mock.calls).toEqual([[["close", "bd-landed", "--reason", reason]]]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("bd-abandoned");
    expect(warn.mock.calls[0]?.[0]).not.toContain("bd-landed");
    log.mockRestore();
    warn.mockRestore();
  });

  it("writes nothing on a dry run", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    settleStrandedBeads(true, new Map());
    expect(bd).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("would close bd-landed: PR #12 merged (dry run)");
    log.mockRestore();
    warn.mockRestore();
  });
});
