import type { BdDependency, BdGate } from "./bd-records.ts";

// bd gate check reports a PR closed without merging only as an `ESCALATE` text line; its --json output has counts alone
export function escalatedGateIds(checked: string): Array<string> {
  const ids: Array<string> = [];
  for (const line of checked.split("\n")) {
    const match = /^\W*(\S+): ESCALATE\b/.exec(line);
    if (match?.[1] !== undefined) {
      ids.push(match[1]);
    }
  }
  return ids;
}

export function humanGatesBlocking(
  beadId: string,
  humanGates: Array<{ blocked: Array<string>; id: string }>,
): Array<string> {
  return humanGates.filter((gate) => gate.blocked.includes(beadId)).map((gate) => gate.id);
}

export function openGatesOfType(gates: Array<BdGate>, awaitType: string): Array<BdGate> {
  return gates
    .filter((gate) => gate.await_type === awaitType && gate.status === "open")
    .toSorted((left, right) => (right.updated_at ?? "").localeCompare(left.updated_at ?? ""));
}

export function latestPrGateCreation(dependencies: Array<BdDependency>): string | undefined {
  let latest: string | undefined;
  for (const { await_type: awaitType, created_at: createdAt, dependency_type: type } of dependencies) {
    if (type !== "blocks" || awaitType !== "gh:pr" || createdAt === undefined) {
      continue;
    }
    if (latest === undefined || Date.parse(createdAt) > Date.parse(latest)) {
      latest = createdAt;
    }
  }
  return latest;
}

export function resolvedPrGateNumbers(dependencies: Array<BdDependency>): Array<number> {
  const prNumbers: Array<number> = [];
  for (const dependency of dependencies) {
    if (
      dependency.dependency_type !== "blocks" ||
      dependency.await_type !== "gh:pr" ||
      dependency.status !== "closed"
    ) {
      continue;
    }
    const prNumber = Number(dependency.await_id);
    if (Number.isSafeInteger(prNumber) && prNumber > 0) {
      prNumbers.push(prNumber);
    }
  }
  return prNumbers;
}

export function strandedBeadIds(
  inProgress: Array<{ assignee: string; id: string }>,
  gatedIds: Set<string>,
): Array<string> {
  return inProgress.filter((bead) => bead.assignee === "" && !gatedIds.has(bead.id)).map((bead) => bead.id);
}

export function prNumberFromUrl(url: string): string | undefined {
  return /\/pull\/(\d+)$/.exec(url)?.[1];
}
