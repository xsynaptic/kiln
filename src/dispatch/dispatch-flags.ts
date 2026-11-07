export const dialDefault = 1;

const dispatchUsage =
  "usage: pnpm kiln dispatch <reconcile|launch> [args]\n" +
  "  reconcile            settle finished runs, close merged gates, reclaim idle slots; launches nothing\n" +
  "  launch               reconcile, then fill free slots from bd ready (--dial <n> caps the fleet)\n" +
  "  both take            --dry-run, --keep-warm <n>";

const keepWarmDefault = 0;

export interface Flags {
  dial: number;
  isDryRun: boolean;
  keepWarm: number;
}

export function parseDispatchArgs(argv: Array<string>): Flags {
  const [subcommand, ...rest] = argv;
  switch (subcommand) {
    case "launch": {
      return parseFlags(rest);
    }
    case "reconcile": {
      if (rest.includes("--dial")) {
        throw new Error(
          "reconcile launches nothing, so it takes no --dial; to launch, pnpm kiln dispatch launch --dial <n>",
        );
      }
      return { ...parseFlags(rest), dial: 0 };
    }
    default: {
      throw new Error(dispatchUsage);
    }
  }
}

function applyFlag(flags: Flags, argv: Array<string>, index: number): number {
  const flag = argv[index];
  switch (flag) {
    case "--dial": {
      flags.dial = countValue(flag, argv[index + 1]);
      return index + 2;
    }
    case "--dry-run": {
      flags.isDryRun = true;
      return index + 1;
    }
    case "--keep-warm": {
      flags.keepWarm = countValue(flag, argv[index + 1]);
      return index + 2;
    }
    default: {
      throw new Error(`unknown argument: ${flag ?? ""}`);
    }
  }
}

function countValue(flag: string, raw: string | undefined): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${flag} takes a non-negative integer`);
  }
  return value;
}

function parseFlags(argv: Array<string>): Flags {
  const flags: Flags = { dial: dialDefault, isDryRun: false, keepWarm: keepWarmDefault };
  let index = 0;
  while (index < argv.length) {
    index = applyFlag(flags, argv, index);
  }
  return flags;
}
