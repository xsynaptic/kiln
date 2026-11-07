import { existsSync } from "node:fs";

import { branchTypes, isBranchType } from "./branches.ts";

const runUsage =
  "usage: pnpm kiln run <kiln-n> --brief <file> --slug <slug> [--type <type>] [--bead <id>] " +
  "[--model <name>] [--base <github-branch>] [--review <pr-number>] [--attach] [--readonly-task-state]";

export interface Args {
  attach: boolean;
  base?: string;
  bead?: string;
  brief: string;
  model?: string;
  name: string;
  noReset: boolean;
  readonlyTaskState: boolean;
  review?: number;
  slug: string;
  type: string;
}

export interface WatchFlags {
  bead: string | undefined;
  review: number | undefined;
}

interface FlagValues {
  attach: boolean;
  base: string | undefined;
  bead: string | undefined;
  brief: string | undefined;
  model: string | undefined;
  noReset: boolean;
  readonlyTaskState: boolean;
  review: string | undefined;
  slug: string | undefined;
  type: string | undefined;
}

export type RunMode = "attended" | "detached" | "gatekeeper";

export function runMode(args: Pick<Args, "attach" | "review">): RunMode {
  if (args.review !== undefined) {
    return "gatekeeper";
  }
  return args.attach ? "attended" : "detached";
}

export function parseArgs(argv: Array<string>): Args {
  const name = argv[0];
  if (!name || name.startsWith("-")) {
    throw new Error(runUsage);
  }
  const flags = readFlags(argv);
  const args: Args = {
    attach: flags.attach,
    brief: requiredBrief(flags.brief),
    name,
    noReset: flags.noReset,
    readonlyTaskState: flags.readonlyTaskState,
    slug: requiredSlug(flags.slug),
    type: requiredType(flags.type),
  };
  return withOptionalArgs(args, flags);
}

export function parseWatchFlags(argv: Array<string>): WatchFlags {
  const beadFlag = argv.indexOf("--bead");
  const reviewFlag = argv.indexOf("--review");
  return {
    bead: beadFlag === -1 ? undefined : argv[beadFlag + 1],
    review: reviewFlag === -1 ? undefined : reviewNumber(argv[reviewFlag + 1]),
  };
}

export function reAnchorCommand(args: Args): string {
  const bead = args.bead === undefined ? "" : ` --bead ${args.bead}`;
  const review = args.review === undefined ? "" : ` --review ${String(args.review)}`;
  return `pnpm kiln watch ${args.name}${bead}${review}`;
}

export function taskBranch(args: Args): string {
  return `${args.type}/${args.slug}`;
}

function applyFlag(flags: FlagValues, argv: Array<string>, index: number): number {
  switch (argv[index]) {
    case "--attach": {
      flags.attach = true;
      return index + 1;
    }
    case "--no-reset": {
      flags.noReset = true;
      return index + 1;
    }
    case "--readonly-task-state": {
      flags.readonlyTaskState = true;
      return index + 1;
    }
    default: {
      assignFlag(flags, argv[index] ?? "", argv[index + 1]);
      return index + 2;
    }
  }
}

function assignFlag(flags: FlagValues, flag: string, value: string | undefined): void {
  if (value === undefined) {
    throw new Error(`${flag} requires a value`);
  }
  switch (flag) {
    case "--base": {
      flags.base = value;
      break;
    }
    case "--bead": {
      flags.bead = value;
      break;
    }
    case "--brief": {
      flags.brief = value;
      break;
    }
    case "--model": {
      flags.model = value;
      break;
    }
    case "--review": {
      flags.review = value;
      break;
    }
    case "--slug": {
      flags.slug = value;
      break;
    }
    case "--type": {
      flags.type = value;
      break;
    }
    default: {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
}

function readFlags(argv: Array<string>): FlagValues {
  const flags: FlagValues = {
    attach: false,
    base: undefined,
    bead: undefined,
    brief: undefined,
    model: undefined,
    noReset: false,
    readonlyTaskState: false,
    review: undefined,
    slug: undefined,
    type: undefined,
  };
  let index = 1;
  while (index < argv.length) {
    index = applyFlag(flags, argv, index);
  }
  return flags;
}

function requiredBrief(brief: string | undefined): string {
  if (brief === undefined || !existsSync(brief)) {
    throw new Error("--brief must name an existing file (the full task brief)");
  }
  return brief;
}

function reviewNumber(value: string | undefined): number {
  const review = Number(value);
  if (!Number.isSafeInteger(review) || review <= 0) {
    throw new Error("--review takes the number of the PR under review");
  }
  return review;
}

function requiredSlug(slug: string | undefined): string {
  if (slug === undefined || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error("--slug is required (kebab-case; becomes <type>/<slug>)");
  }
  return slug;
}

function requiredType(type = "feat"): string {
  if (!isBranchType(type)) {
    throw new Error(`--type must be a conventional-commit type (${branchTypes.join(", ")})`);
  }
  return type;
}

// The model and base branch end up in shell commands inside the VM, so they are checked rather than passed through
function withOptionalArgs(args: Args, flags: FlagValues): Args {
  const complete = { ...args };
  if (flags.model !== undefined) {
    if (!/^[a-z0-9][a-z0-9.-]*$/i.test(flags.model)) {
      throw new Error("--model takes a model name or alias (letters, digits, dots, dashes)");
    }
    complete.model = flags.model;
  }
  if (flags.base !== undefined) {
    if (!/^[a-z0-9][\w./-]*$/i.test(flags.base)) {
      throw new Error("--base takes a branch name on the github remote");
    }
    complete.base = flags.base;
  }
  if (flags.bead !== undefined) {
    complete.bead = flags.bead;
  }
  if (flags.review !== undefined) {
    complete.review = reviewNumber(flags.review);
  }
  return complete;
}

export function modelFlag(model: string | undefined): string {
  return model === undefined ? "" : ` --model ${model}`;
}
