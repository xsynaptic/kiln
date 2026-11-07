import process from "node:process";

import { crank } from "./dispatch.ts";
import { crankHeader, crankSummaryLines } from "./format.ts";

/** @internal */
export interface LoopControl {
  isStopRequested: boolean;
}

export interface LoopFlags {
  dial: number;
  pollSeconds: number;
  runs?: number;
}

interface StopInput {
  budgetLeft: number;
  inFlight: number;
  openGates: number;
  ready: number;
}

/** @internal */
export function shouldStop(input: StopInput): boolean {
  if (input.budgetLeft <= 0) {
    return input.inFlight === 0;
  }
  return input.inFlight === 0 && input.ready === 0 && input.openGates === 0;
}

const stopMessage =
  "stopping the loop after one last crank to reconcile and bring idle slots down. In-flight runs " +
  "keep going and reconcile on the next loop or dispatch; to stop one and free its slot now, `pnpm kiln rm <slot>`.";

// pnpm relays one Ctrl-C as a burst of signals with uneven timing, so any signal means stop and repeats do nothing
/** @internal */
export function applyLoopSignal(control: LoopControl): string | undefined {
  if (control.isStopRequested) {
    return undefined;
  }
  control.isStopRequested = true;
  return stopMessage;
}

export async function drive(flags: LoopFlags, repoRoot: string): Promise<void> {
  let blockedStreak = 0;
  let launchedTotal = 0;
  let lastInFlight = 0;
  let wake: (() => void) | undefined;
  // Kept in an object, because TypeScript can't see the signal handler change a plain `let` and would keep it narrowed
  const control: LoopControl = { isStopRequested: false };
  const isStopRequested = (): boolean => control.isStopRequested;

  const onSignal = (): void => {
    const message = applyLoopSignal(control);
    if (message !== undefined) {
      console.log(`\n${message}`);
    }
    wake?.();
  };
  // SIGTERM and SIGHUP also arrive when the wrapper tears down after a Ctrl-C
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);

  try {
    for (let crankNumber = 1; ; crankNumber += 1) {
      const plan = crankPlan(flags, launchedTotal, lastInFlight);

      console.log(crankHeader(crankNumber, plan.isWinddown));
      const summary = await crank(
        { dial: plan.dial, isDryRun: false, keepWarm: plan.keepWarm },
        repoRoot,
        plan.options,
      );
      blockedStreak = summary.isBlocked ? blockedStreak + 1 : 0;
      launchedTotal += summary.launched;
      lastInFlight = summary.inFlight;
      console.log(crankSummaryLines(summary, launchedTotal, blockedStreak));

      if (isStopRequested()) {
        break;
      }
      if (
        shouldStop({
          budgetLeft: remainingRuns(flags, launchedTotal),
          inFlight: summary.inFlight,
          openGates: summary.openGates,
          ready: summary.ready,
        })
      ) {
        console.log(stopReason(remainingRuns(flags, launchedTotal), launchedTotal));
        break;
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, flags.pollSeconds * 1000);
        wake = (): void => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
      if (isStopRequested()) {
        break;
      }
    }
    await crank({ dial: 0, isDryRun: false, keepWarm: 0 }, repoRoot, { quiet: true });
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGHUP", onSignal);
  }
}

function crankPlan(flags: LoopFlags, launchedTotal: number, lastInFlight: number) {
  const budgetLeft = remainingRuns(flags, launchedTotal);
  if (budgetLeft <= 0) {
    return { dial: 0, isWinddown: true, keepWarm: 0, options: { quiet: true } };
  }
  return {
    dial: flags.dial,
    isWinddown: false,
    keepWarm: lastInFlight > 0 ? flags.dial : 0,
    options: { maxLaunch: budgetLeft, quiet: true },
  };
}

function remainingRuns(flags: LoopFlags, launchedTotal: number): number {
  return flags.runs === undefined ? Infinity : flags.runs - launchedTotal;
}

function stopReason(budgetLeft: number, launchedTotal: number): string {
  const tail = `${String(launchedTotal)} run(s) launched.`;
  if (budgetLeft <= 0) {
    return `run budget reached and drained; ${tail} Stopped.`;
  }
  return `nothing ready and nothing in flight; ${tail} Stopped.`;
}
