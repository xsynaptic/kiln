import type { LoopFlags } from "../dispatch/loop.ts";

import { dialDefault } from "../dispatch/dispatch-flags.ts";
import { drive } from "../dispatch/loop.ts";
import { mainCheckoutPath } from "../shared/run-artifacts.ts";
import { didEnsureBeadsServer } from "../vm/beads.ts";
import { acquireLease } from "../vm/lease.ts";

const pollSecondsDefault = 30;

export async function run(argv: Array<string>): Promise<void> {
  const flags = parseFlags(argv);
  const repoRoot = mainCheckoutPath();
  const releaseLease = acquireLease(repoRoot, "dispatch", "loop");
  try {
    if (!didEnsureBeadsServer()) {
      console.error("beads store is unavailable and could not be started; nothing to loop");
      return;
    }
    await drive(flags, repoRoot);
  } finally {
    releaseLease();
  }
}

function applyFlag(flags: LoopFlags, argv: Array<string>, index: number): number {
  const flag = argv[index];
  switch (flag) {
    case "--dial": {
      flags.dial = positiveInt(flag, argv[index + 1]);
      return index + 2;
    }
    case "--poll": {
      flags.pollSeconds = positiveInt(flag, argv[index + 1]);
      return index + 2;
    }
    case "--runs": {
      flags.runs = positiveInt(flag, argv[index + 1]);
      return index + 2;
    }
    default: {
      throw new Error(`unknown argument: ${flag ?? ""}`);
    }
  }
}

function parseFlags(argv: Array<string>): LoopFlags {
  const flags: LoopFlags = { dial: dialDefault, pollSeconds: pollSecondsDefault };
  let index = 0;
  while (index < argv.length) {
    index = applyFlag(flags, argv, index);
  }
  return flags;
}

function positiveInt(flag: string, raw: string | undefined): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${flag} takes a positive integer`);
  }
  return value;
}
