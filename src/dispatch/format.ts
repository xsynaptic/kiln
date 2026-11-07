import chalk from "chalk";

import type { CrankSummary } from "./dispatch.ts";

const labelWidth = 10;
const separator = chalk.dim(" · ");

export function crankHeader(crankNumber: number, isDraining: boolean, at: Date = new Date()): string {
  const drainNote = isDraining ? ` ${chalk.yellow("(draining)")}` : "";
  const time = [at.getHours(), at.getMinutes(), at.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
  return `\n${chalk.dim("──")} ${chalk.bold(`crank ${String(crankNumber)}`)}${drainNote} ${chalk.dim("──")} ${chalk.dim(time)}`;
}

export function crankSummaryLines(summary: CrankSummary, launchedTotal: number, blockedStreak = 0): string {
  const parkedPhrase = countPhrase(summary.parked.length, "parked", "parked", chalk.red);
  const queue = [
    countPhrase(summary.ready, "bead ready to dispatch", "beads ready to dispatch", chalk.cyan),
    countPhrase(summary.openGates, "PR awaiting merge", "PRs awaiting merge", chalk.magenta),
    summary.parked.length === 0 ? parkedPhrase : `${parkedPhrase} ${chalk.dim(`(${summary.parked.join(", ")})`)}`,
  ].join(separator);
  const runs = [
    countPhrase(summary.inFlight, "in flight", "in flight", chalk.yellow),
    countPhrase(summary.launched, "launched this crank", "launched this crank", chalk.green),
    chalk.dim(`${String(launchedTotal)} total this loop`),
  ];
  if (summary.stalled > 0) {
    runs.push(chalk.red(`${String(summary.stalled)} past the run ceiling`));
  }
  if (blockedStreak > 0) {
    runs.push(chalk.red(`held ${String(blockedStreak)} in a row for provider errors`));
  }
  return [labeled("queue", queue), labeled("runs", runs.join(separator))].join("\n");
}

export function labeled(label: string, body: string): string {
  return `${chalk.dim(label.padEnd(labelWidth))}${body}`;
}

export function slotList(slots: Array<{ busy: boolean; name: string; state: string }>): string {
  const parts = slots.map((slot) =>
    slot.busy ? `${slot.name} ${chalk.yellow("busy")}` : `${slot.name} ${chalk.dim(slot.state)}`,
  );
  return parts.join(separator);
}

function countPhrase(value: number, singular: string, plural: string, colorize: (text: string) => string): string {
  const phrase = value === 1 ? singular : plural;
  if (value === 0) {
    return chalk.dim(`0 ${phrase}`);
  }
  return `${colorize(chalk.bold(String(value)))} ${phrase}`;
}
