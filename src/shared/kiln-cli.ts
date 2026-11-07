import type { ChildProcess, SpawnOptions } from "node:child_process";

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

// Same extension as this module, so a source checkout spawns the .ts entry and an install spawns the built .js
const cliPath = path.join(import.meta.dirname, "..", `kiln.cli${path.extname(import.meta.filename)}`);

export function spawnKiln(args: ReadonlyArray<string>, options: SpawnOptions): ChildProcess {
  return spawn(process.execPath, [cliPath, ...args], options);
}
