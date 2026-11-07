import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { run } from "#src/commands/rm.ts";
import { runOrThrow } from "#src/shared/proc.ts";
import { mainCheckoutPath } from "#src/shared/run-artifacts.ts";
import { killBeadsTunnel } from "#src/vm/beads.ts";
import { acquireLease, readLiveLease } from "#src/vm/lease.ts";
import { mirrorRefspec, rescueOutcomeLine, selectUnpushedBranches } from "#src/vm/rescue.ts";
import { didScpFromGuest, guestClonePath, isVmRunning, sshCaptureSafe, sshScript } from "#src/vm/vm.ts";

vi.mock(import("node:child_process"), async (importOriginal) => ({
  ...(await importOriginal()),
  spawnSync: vi.fn(),
}));

vi.mock(import("#src/vm/vm.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  didScpFromGuest: vi.fn(),
  guestClonePath: vi.fn(),
  isVmRunning: vi.fn(),
  sshCaptureSafe: vi.fn(),
  sshScript: vi.fn(),
}));

vi.mock(import("#src/vm/beads.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  killBeadsTunnel: vi.fn(),
}));

vi.mock(import("#src/shared/proc.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  runOrThrow: vi.fn(),
}));

vi.mock(import("#src/shared/run-artifacts.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  mainCheckoutPath: vi.fn(),
}));

const slot = "kiln-2";

// What the teardown touched, in order: the tunnel, the guest, colima and git on the host
let calls: Array<string> = [];
let repoRoot = "";

const newTip = "a".repeat(40);
const otherTip = "b".repeat(40);
const staleTip = "c".repeat(40);

// The guest's branch report: commits no remote has, the tip, the branch
function line(count: number, branch: string, tip = newTip): string {
  return `${String(count)} ${tip} ${branch}`;
}

interface Clone {
  arrived: Array<[branch: string, tip: string]>;
  isBundleFailing: boolean;
  report: string;
}

function noKeepAwake(): undefined {
  return;
}

function slotWith(clone: Clone): void {
  vi.mocked(sshScript).mockImplementation((_profile, script) => {
    calls.push(script.includes("git bundle create") ? "guest bundle" : "guest drop branches");
    if (clone.isBundleFailing && script.includes("git bundle create")) {
      throw new Error("bundle failed");
    }
  });
  vi.mocked(sshCaptureSafe).mockImplementation(() => {
    calls.push("guest report");
    return clone.report;
  });
  vi.mocked(spawnSync).mockImplementation(((_command: string, args: ReadonlyArray<string>) => {
    const ref = args.at(-1) ?? "";
    const mirror = clone.arrived.find(([branch]) => ref === `refs/kiln/${slot}/${branch}`);
    return mirror === undefined ? { status: 1, stdout: "" } : { status: 0, stdout: `${mirror[1]}\n` };
  }) as unknown as typeof spawnSync);
}

function rm(...argv: Array<string>): void {
  run([slot, ...argv]);
}

beforeEach(() => {
  vi.restoreAllMocks();
  calls = [];
  repoRoot = mkdtempSync(path.join(tmpdir(), "kiln-rm-"));
  vi.stubEnv("KILN_RUNS_DIR", path.join(repoRoot, "runs"));
  vi.mocked(mainCheckoutPath).mockReturnValue(repoRoot);
  vi.mocked(guestClonePath).mockReturnValue("/mnt/lima-data/work/sample");
  vi.mocked(isVmRunning).mockImplementation(() => {
    calls.push("colima status");
    return true;
  });
  vi.mocked(killBeadsTunnel).mockImplementation(() => {
    calls.push("kill tunnel");
  });
  vi.mocked(didScpFromGuest).mockImplementation(() => {
    calls.push("scp bundle");
    return true;
  });
  vi.mocked(runOrThrow).mockImplementation((command, args) => {
    calls.push(`${command} ${args.slice(0, 1).join(" ")}${args.includes("--data") ? " --data" : ""}`);
  });
  slotWith({ arrived: [], isBundleFailing: false, report: line(0, "main") });
  vi.spyOn(console, "log").mockReturnValue();
  vi.spyOn(console, "warn").mockReturnValue();
});

describe("kiln rm refuses to destroy what it cannot save", () => {
  it("refuses a slot a live run leases before it touches the tunnel, the guest or colima", () => {
    const release = acquireLease(repoRoot, slot, "blind run", noKeepAwake);
    try {
      expect(() => {
        rm("--delete");
      }).toThrow("leased by a live blind run");
    } finally {
      release();
    }
    expect(calls).toEqual([]);
  });

  it("refuses to delete a stopped VM, whose clone it cannot rescue, without calling colima on it", () => {
    vi.mocked(isVmRunning).mockReturnValue(false);
    expect(() => {
      rm("--delete");
    }).toThrow("cannot be rescued before deletion");
    expect(calls).toEqual(["kill tunnel"]);
  });

  it("does nothing more to a stopped VM asked only to stop", () => {
    vi.mocked(isVmRunning).mockReturnValue(false);
    rm();
    expect(calls).toEqual(["kill tunnel"]);
  });

  it("refuses to delete after a failed rescue, and still lets a stop through", () => {
    slotWith({ arrived: [], isBundleFailing: true, report: line(2, "feat/sample") });
    expect(() => {
      rm("--delete");
    }).toThrow("refusing to delete kiln-2: branch rescue failed");
    expect(calls).not.toContain("colima delete --data");
    rm();
    expect(calls.at(-1)).toBe("colima stop");
  });

  it("counts a rescue that mirrored fewer branches than it found as failed", () => {
    slotWith({
      arrived: [["feat/sample", newTip]],
      isBundleFailing: false,
      report: [line(2, "feat/sample"), line(1, "fix/other", otherTip)].join("\n"),
    });
    expect(() => {
      rm("--delete");
    }).toThrow("branch rescue failed");
    expect(calls).not.toContain("colima delete --data");
  });

  it("counts a branch the fetch skipped as unrescued, though an earlier teardown left its mirror ref", () => {
    slotWith({ arrived: [["feat/sample", staleTip]], isBundleFailing: false, report: line(2, "feat/sample") });
    expect(() => {
      rm("--delete");
    }).toThrow("branch rescue failed");
    expect(calls).not.toContain("colima delete --data");
    rm();
    expect(calls).not.toContain("guest drop branches");
  });
});

describe("kiln rm tears a slot down in order", () => {
  it("deletes the disk with the VM, after mirroring its unpushed branches, and leaves them in the clone", () => {
    slotWith({
      arrived: [["feat/sample", newTip]],
      isBundleFailing: false,
      report: [line(0, "main", otherTip), line(2, "feat/sample")].join("\n"),
    });
    rm("--delete");
    expect(calls).toEqual([
      "kill tunnel",
      "colima status",
      "guest bundle",
      "guest report",
      "scp bundle",
      "git fetch",
      "colima delete --data",
    ]);
  });

  it("stops without touching the disk, dropping the branches it mirrored", () => {
    slotWith({
      arrived: [["feat/sample", newTip]],
      isBundleFailing: false,
      report: [line(0, "main", otherTip), line(2, "feat/sample")].join("\n"),
    });
    rm();
    expect(calls).toEqual([
      "kill tunnel",
      "colima status",
      "guest bundle",
      "guest report",
      "scp bundle",
      "git fetch",
      "guest drop branches",
      "colima stop",
    ]);
  });

  it("holds the slot lease for the whole teardown, so a launch that lands mid-rescue is refused", () => {
    let leaseMidRescue: string | undefined;
    let launchMidRescue = "never tried";
    vi.mocked(sshCaptureSafe).mockImplementation(() => {
      leaseMidRescue = readLiveLease(repoRoot, slot)?.mode;
      try {
        acquireLease(repoRoot, slot, "blind run", noKeepAwake)();
        launchMidRescue = "acquired";
      } catch (error) {
        launchMidRescue = error instanceof Error ? error.message : String(error);
      }
      return line(0, "main");
    });
    rm("--delete");
    expect(leaseMidRescue).toBe("teardown");
    expect(launchMidRescue).toContain("leased by a live teardown");
    expect(readLiveLease(repoRoot, slot)).toBeUndefined();
  });
});

describe("selectUnpushedBranches", () => {
  it("keeps branches with commits no remote has, with their tips, and drops the rest", () => {
    const report = [
      line(0, "main"),
      line(3, "feat/batch-exports"),
      line(0, "feat/delivered"),
      line(1, "rescue/kiln-1-abc", otherTip),
    ].join("\n");
    expect(selectUnpushedBranches(report)).toEqual([
      { branch: "feat/batch-exports", tip: newTip },
      { branch: "rescue/kiln-1-abc", tip: otherTip },
    ]);
  });

  it("mirrors nothing when every branch is already upstream", () => {
    expect(selectUnpushedBranches([line(0, "main"), line(0, "feat/done")].join("\n"))).toEqual([]);
  });

  it("ignores blank and malformed lines, and a line with no tip", () => {
    expect(selectUnpushedBranches(`\n${line(2, "feat/keep")}\n\ngarbage\n2 feat/no-tip\n`)).toEqual([
      { branch: "feat/keep", tip: newTip },
    ]);
  });
});

describe("mirrorRefspec", () => {
  it("namespaces each branch under the slot", () => {
    expect(mirrorRefspec("kiln-1", "feat/x")).toBe("+refs/heads/feat/x:refs/kiln/kiln-1/feat/x");
  });
});

describe("rescueOutcomeLine", () => {
  it("points a failed rescue at the directory to look in", () => {
    expect(
      rescueOutcomeLine({
        isBranchesOk: false,
        mirrored: 2,
        rescuePath: ".agent-runs/transcripts/kiln-1-teardown",
        slot: "kiln-1",
      }),
    ).toBe("kiln-1: branches NOT rescued -> .agent-runs/transcripts/kiln-1-teardown");
  });

  it("names no directory when a clean clone mirrored nothing", () => {
    expect(rescueOutcomeLine({ isBranchesOk: true, mirrored: 0, rescuePath: ".agent-runs/x", slot: "kiln-1" })).toBe(
      "kiln-1: no unpushed branches to mirror",
    );
  });

  it("names the directory the mirrored branches landed beside, counting and pluralizing them", () => {
    expect(rescueOutcomeLine({ isBranchesOk: true, mirrored: 1, rescuePath: ".agent-runs/x", slot: "kiln-1" })).toBe(
      "kiln-1: mirrored 1 unpushed branch -> refs/kiln/kiln-1/* (.agent-runs/x)",
    );
    expect(rescueOutcomeLine({ isBranchesOk: true, mirrored: 2, rescuePath: ".agent-runs/x", slot: "kiln-2" })).toBe(
      "kiln-2: mirrored 2 unpushed branches -> refs/kiln/kiln-2/* (.agent-runs/x)",
    );
  });
});
