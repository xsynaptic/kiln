import { mapValues } from "remeda";

import { kilnConfig } from "../config/config.ts";

// Lima silently drops a forward whose host port is taken, so slot port blocks must never overlap

const devPortDefaults = kilnConfig.slots.devPorts;

export interface PortBlock {
  offset: number;
  ports: Record<string, number>;
}

const agentOffsetBase = 0;
const agentSlotMin = 1;
const agentSlotMax = 8;

export const agentSlotNames = Array.from(
  { length: agentSlotMax - agentSlotMin + 1 },
  (_unused, index) => `kiln-${String(agentSlotMin + index)}`,
);

export function agentPortBlock(slot: number): PortBlock {
  const offset = agentOffsetBase + slot;
  const ports = mapValues(devPortDefaults, (port) => port + offset * 1000);
  return { offset, ports };
}

export function agentSlotFromName(name: string): number | undefined {
  const match = /^kiln-([1-9])$/.exec(name);
  if (!match) {
    return undefined;
  }
  const slot = Number(match[1]);
  return slot >= agentSlotMin && slot <= agentSlotMax ? slot : undefined;
}

export function pinEnvPorts(content: string, block: PortBlock): string {
  const keys = Object.keys(block.ports);
  const kept = content.split("\n").filter((line) => keys.every((key) => !line.startsWith(`${key}=`)));
  const pins = [
    `# Agent slot stack (written by kiln new): port block +${String(block.offset)}000`,
    ...keys.map((key) => `${key}=${String(block.ports[key])}`),
  ];
  return [...kept, ...pins, ""].join("\n").replaceAll(/\n{3,}/g, "\n\n");
}
