#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseEnv } from "node:util";

import { mainCheckoutPath } from "./shared/run-artifacts.ts";

// Only KILN_ variables, because every process this CLI starts inherits its environment
function loadKilnEnv(): void {
  const envFile = path.join(mainCheckoutPath(), ".env");
  if (!existsSync(envFile)) {
    return;
  }
  const parsed = parseEnv(readFileSync(envFile, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith("KILN_") && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const usageText =
  "usage: pnpm kiln <new|run|review|rm|attach|shell|watch|dispatch|loop|report|host-id> [args]\n" +
  "  new <kiln-n>         provision (or refresh) a slot VM\n" +
  "  run <kiln-n> ...     one agent run in a slot (--attach for attended)\n" +
  "  review <kiln-n> --pr <n> [--bead <id>]  gatekeeper run against an open PR\n" +
  "  rm <kiln-n>          rescue and stop a slot (--delete removes the VM)\n" +
  "  attach <kiln-n>      join a slot's attended run (--read-only observes)\n" +
  "  shell <kiln-n>       free-form interactive claude in a slot (no brief or receipt)\n" +
  "  watch <kiln-n>       re-anchor onto a live run whose wrapper died (writes its receipt)\n" +
  "  dispatch reconcile   settle finished runs, close merged gates, reclaim idle slots\n" +
  "  dispatch launch      reconcile, then fill free slots from bd ready (--dial <n> caps the fleet)\n" +
  "  loop                 dispatch on a poll until drained; Ctrl-C stops it, leaving runs alone\n" +
  "                       (--runs <n> caps launches, --dial <n>, --poll <seconds>)\n" +
  "  report               debrief over the run ledger (--since <yyyy-mm-dd>, default a week back)\n" +
  "  host-id              attribute this host checkout's Claude git/gh writes to the machine user";

async function main(): Promise<void> {
  loadKilnEnv();
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "attach": {
      const { run } = await import("./commands/attach.ts");
      await run(rest);
      break;
    }
    case "dispatch": {
      const { run } = await import("./commands/dispatch.ts");
      await run(rest);
      break;
    }
    case "host-id": {
      const { run } = await import("./commands/host-id.ts");
      run();
      break;
    }
    case "loop": {
      const { run } = await import("./commands/loop.ts");
      await run(rest);
      break;
    }
    case "new": {
      const { run } = await import("./commands/new.ts");
      await run(rest);
      break;
    }
    case "report": {
      const { run } = await import("./commands/report.ts");
      run(rest);
      break;
    }
    case "review": {
      const { run } = await import("./commands/review.ts");
      await run(rest);
      break;
    }
    case "rm": {
      const { run } = await import("./commands/rm.ts");
      run(rest);
      break;
    }
    case "run": {
      const { run } = await import("./commands/run.ts");
      await run(rest);
      break;
    }
    case "shell": {
      const { run } = await import("./commands/shell.ts");
      await run(rest);
      break;
    }
    case "watch": {
      const { run } = await import("./commands/watch.ts");
      await run(rest);
      break;
    }
    default: {
      throw new Error(usageText);
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
