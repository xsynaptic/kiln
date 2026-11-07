import { parseEach } from "../shared/lenient-json.ts";
import { bd, bdJson, bdShow, listGates, unclaimFromSlot } from "./bd-client.ts";
import { bdDependencySchema, bdGateSchema } from "./bd-records.ts";
import { latestPrGateCreation, openGatesOfType, prNumberFromUrl } from "./gate-reads.ts";

export interface GateParks {
  beadsByGate: Map<string, Array<string>>;
  parkedIds: Set<string>;
}

export interface ParkGate {
  blocked: Array<string>;
  id: string;
}

export function gateBlockedBeads(gateId: string, beadsByGate: Map<string, Array<string>>): Array<string> {
  const cached = beadsByGate.get(gateId);
  if (cached !== undefined) {
    return cached;
  }
  const dependencies = parseEach(bdDependencySchema, bdJson(["dep", "list", gateId, "--direction", "up", "--json"]));
  const ids: Array<string> = [];
  for (const { dependency_type: type, id } of dependencies) {
    if (id !== undefined && type === "blocks") {
      ids.push(id);
    }
  }
  beadsByGate.set(gateId, ids);
  return ids;
}

export function latestPrGateOn(beadId: string): string | undefined {
  return latestPrGateCreation(parseEach(bdDependencySchema, bdJson(["dep", "list", beadId, "--json"])));
}

export function isGateLive(blockedBeadIds: Array<string>, parkedIds: Set<string>): boolean {
  return blockedBeadIds.some((beadId) => !parkedIds.has(beadId));
}

export function liveGatesOf<Gate extends { id: string }>(
  gates: Array<Gate>,
  beadsByGate: Map<string, Array<string>>,
  parkedIds: Set<string>,
): Array<Gate> {
  return gates.filter((gate) => isGateLive(gateBlockedBeads(gate.id, beadsByGate), parkedIds));
}

export function openPrGate(beadId: string, prNumber: string, prUrl: string): void {
  bd([
    "gate",
    "create",
    "--type=gh:pr",
    "--blocks",
    beadId,
    `--await-id=${prNumber}`,
    "--reason",
    `close on merge of ${prUrl}`,
  ]);
}

export function openGhPrGates(): Array<{ awaitId: string; id: string }> {
  const gates: Array<{ awaitId: string; id: string }> = [];
  for (const { await_id: awaitId, id } of openGatesOfType(listGates(), "gh:pr")) {
    if (id !== undefined && awaitId !== undefined) {
      gates.push({ awaitId, id });
    }
  }
  return gates;
}

export function parkBead(beadId: string, slot: string, reason: string, parkedIds: Set<string>): void {
  const gateId = openHumanGate(beadId, reason);
  bd(["comment", beadId, `${reason}; parked for a human look. Unpark with: ${unparkHint(gateId)}`]);
  unclaimFromSlot(beadId, slot, reason);
  parkedIds.add(beadId);
}

export function parkWithOpenPr(
  run: { beadId: string; prUrl: string; slot: string },
  reason: string,
  parkedIds: Set<string>,
): void {
  parkBead(run.beadId, run.slot, reason, parkedIds);
  const prNumber = prNumberFromUrl(run.prUrl);
  if (prNumber !== undefined) {
    openPrGate(run.beadId, prNumber, run.prUrl);
  }
}

export function parkBehindGate(
  gate: { awaitId: string; id: string },
  reason: string,
  parks: GateParks,
  detail: string = reason,
): void {
  const { beadsByGate, parkedIds } = parks;
  for (const beadId of gateBlockedBeads(gate.id, beadsByGate)) {
    const bead = bdShow(beadId);
    if (bead === undefined || bead.status === "closed") {
      continue;
    }
    if (!parkedIds.has(beadId)) {
      const gateId = openHumanGate(beadId, reason);
      bd([
        "comment",
        beadId,
        `${detail}\n\nParked for a human. Land the PR and this bead closes itself on the next crank. Want an agent to redo the work instead: close the PR, then ${unparkHint(gateId)}.`,
      ]);
      parkedIds.add(beadId);
      console.log(`parked ${beadId}: ${reason}`);
    }
    // Reopen even a bead that was already parked, since bd ready skips in_progress; `unclaim` won't, as nobody holds it
    if (bead.status === "in_progress" && bead.assignee === "") {
      bd(["update", beadId, "--status", "open"]);
    }
  }
}

export function parkedBeads(beadsByGate: Map<string, Array<string>>): Array<string> {
  return [...new Set(parkGates(beadsByGate).flatMap((gate) => gate.blocked))];
}

export function parkGates(beadsByGate: Map<string, Array<string>>): Array<ParkGate> {
  const parks: Array<ParkGate> = [];
  for (const { id } of openGatesOfType(listGates(), "human")) {
    if (id !== undefined) {
      parks.push({ blocked: gateBlockedBeads(id, beadsByGate), id });
    }
  }
  return parks;
}

// The claim stays because reconcile finds runs by assignee, so a run that delivers after the ceiling still gets its PR gate
export function parkStalledRun(beadId: string, slot: string, ceilingHours: number, parkedIds: Set<string>): void {
  const gateId = openHumanGate(beadId, `run past the ${String(ceilingHours)}h ceiling on ${slot}`);
  bd([
    "comment",
    beadId,
    `${slot} has been busy with this run for over ${String(ceilingHours)}h, past the wall-clock ceiling; parked for a human look. The guest was left alone, so the run may yet deliver, and a PR it opens still gates this bead. Check the slot before unparking (${unparkHint(gateId)}): pnpm kiln attach ${slot}`,
  ]);
  parkedIds.add(beadId);
}

function openHumanGate(beadId: string, reason: string): string | undefined {
  const [gate] = parseEach(
    bdGateSchema,
    bdJson(["gate", "create", "--type=human", "--blocks", beadId, "--reason", reason, "--json"]),
  );
  return gate?.id;
}

function unparkHint(gateId: string | undefined): string {
  return gateId === undefined ? "bd gate list" : `bd gate resolve ${gateId}`;
}
