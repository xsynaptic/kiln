import { startRun } from "../run/launch-run.ts";
import { parseArgs } from "../run/run-args.ts";

export async function run(argv: Array<string>): Promise<void> {
  await startRun(parseArgs(argv));
}
