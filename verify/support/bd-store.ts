import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, vi } from "vitest";

import { bdJson } from "#src/queue/bd-client.ts";
import { bdGateSchema, bdIssueSchema } from "#src/queue/bd-records.ts";
import { parseEach } from "#src/shared/lenient-json.ts";

export interface BdStore {
  claimedBead: (title: string, slot: string) => string;
  createBead: (title: string, priority?: string) => string;
  prGateOn: (id: string, prNumber: string) => { awaitId: string; id: string };
  root: () => string;
  shell: (command: string, args: Array<string>) => void;
}

function runIn(root: string, command: string, args: Array<string>): void {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")}: ${result.stderr}`);
  }
}

function createBead(title: string, priority = "2"): string {
  const [issue] = parseEach(bdIssueSchema, [bdJson(["create", title, "--priority", priority, "--json"])]);
  const id = issue?.id;
  if (id === undefined) {
    throw new Error(`bd create answered no id for ${title}`);
  }
  return id;
}

function prGateOn(id: string, prNumber: string): { awaitId: string; id: string } {
  const [gate] = parseEach(bdGateSchema, [
    bdJson(["gate", "create", "--type=gh:pr", "--blocks", id, `--await-id=${prNumber}`, "--json"]),
  ]);
  const gateId = gate?.id;
  if (gateId === undefined) {
    throw new Error(`bd gate create answered no id for ${id}`);
  }
  return { awaitId: prNumber, id: gateId };
}

export function initBdStore(): string {
  const root = mkdtempSync(path.join(tmpdir(), "kiln-bd-"));
  runIn(root, "git", ["init", "--quiet"]);
  runIn(root, "bd", ["init", "--quiet"]);
  return root;
}

// BEADS_DIR takes priority over discovery, which keeps every write off the project's own queue
export function useBdStore(): BdStore {
  let root = "";

  function shell(command: string, args: Array<string>): void {
    runIn(root, command, args);
  }

  function claimedBead(title: string, slot: string): string {
    const id = createBead(title);
    shell("bd", ["update", id, "--claim", "--actor", slot]);
    return id;
  }

  beforeAll(() => {
    root = initBdStore();
    vi.stubEnv("BEADS_DIR", path.join(root, ".beads"));
  }, 60_000);

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(root, { force: true, recursive: true });
  });

  return { claimedBead, createBead, prGateOn, root: () => root, shell };
}
