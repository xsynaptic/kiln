import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { omit } from "remeda";
import { beforeEach, describe, expect, it } from "vitest";

import { agentRunsPath } from "#src/shared/run-artifacts.ts";
import { acquireLease, readLiveLease } from "#src/vm/lease.ts";

function deadPid(): number {
  return spawnSync(process.execPath, ["--version"], { stdio: "ignore" }).pid;
}

function freshRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "lease-test-"));
}

function noKeepAwake(): undefined {
  return;
}

describe("acquireLease", () => {
  beforeEach(() => {
    delete process.env.KILN_RUNS_DIR;
  });

  it("holds the name while the wrapper lives and frees it on release", () => {
    const root = freshRoot();
    const release = acquireLease(root, "kiln-1", "blind run", noKeepAwake);
    expect(readLiveLease(root, "kiln-1")?.pid).toBe(process.pid);
    expect(() => acquireLease(root, "kiln-1", "blind run", noKeepAwake)).toThrow(/leased/);
    release();
    expect(readLiveLease(root, "kiln-1")).toBeUndefined();
  });

  it("leases per name, not globally", () => {
    const root = freshRoot();
    acquireLease(root, "kiln-1", "blind run", noKeepAwake);
    expect(() => acquireLease(root, "dispatch", "dispatch", noKeepAwake)).not.toThrow();
  });

  it("holds a keep-awake assertion for exactly the lease lifetime", () => {
    const root = freshRoot();
    let spawned = 0;
    let killed = 0;
    const release = acquireLease(root, "kiln-1", "blind run", () => {
      spawned += 1;
      return {
        kill: () => {
          killed += 1;
        },
      };
    });
    expect(spawned).toBe(1);
    expect(killed).toBe(0);
    release();
    expect(killed).toBe(1);
  });

  it("treats a dead holder as stale and takes over", () => {
    const root = freshRoot();
    const file = agentRunsPath(root, "locks", "kiln-1.lock");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ mode: "blind run", pid: deadPid(), startedAt: "" }));
    expect(readLiveLease(root, "kiln-1")).toBeUndefined();
    expect(() => acquireLease(root, "kiln-1", "blind run", noKeepAwake)).not.toThrow();
  });

  it("reads a live holder that wrote only its pid, so the refusal can still name it", () => {
    const root = freshRoot();
    const file = agentRunsPath(root, "locks", "kiln-1.lock");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ mode: 7, pid: process.pid }));
    expect(readLiveLease(root, "kiln-1")).toEqual({ mode: "unknown", pid: process.pid, startedAt: "" });
  });

  it("treats garbage on file as stale", () => {
    const root = freshRoot();
    const file = agentRunsPath(root, "locks", "kiln-1.lock");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "not json");
    expect(readLiveLease(root, "kiln-1")).toBeUndefined();
  });
});

const contender = `
const [leaseModule, root, startAt] = process.argv.slice(1);
const { acquireLease } = await import(leaseModule);
while (Date.now() < Number(startAt)) {}
try {
  acquireLease(root, "kiln-1", "contender", () => undefined);
  console.log("won");
  await new Promise((resolve) => setTimeout(resolve, 1500));
} catch {
  console.log("lost");
}
`;

describe("acquireLease across processes", () => {
  it("lets exactly one of many simultaneous contenders take a free slot", async () => {
    const root = freshRoot();
    const leaseModule = path.join(import.meta.dirname, "../../../src/vm/lease.ts");
    const startAt = String(Date.now() + 1000);
    const contenders = Array.from(
      { length: 8 },
      () =>
        new Promise<string>((resolve) => {
          const child = spawn(process.execPath, ["--input-type=module", "-e", contender, leaseModule, root, startAt], {
            env: omit(process.env, ["KILN_RUNS_DIR"]),
          });
          let output = "";
          child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
          });
          child.on("close", () => {
            resolve(output.trim());
          });
        }),
    );
    const outcomes = await Promise.all(contenders);
    expect(outcomes.filter((outcome) => outcome === "won")).toEqual(["won"]);
  }, 20_000);
});
