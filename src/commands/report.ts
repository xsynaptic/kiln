import { readReceipts } from "../dispatch/reconcile.ts";
import { formatReport, formatSlugBlock } from "../dispatch/report.ts";
import { mainCheckoutPath } from "../shared/run-artifacts.ts";

const dayMs = 86_400_000;
const defaultWindowDays = 7;
const usageText = "usage: pnpm kiln report [--since <yyyy-mm-dd>]";

/** @internal */
export function parseSince(argv: Array<string>, nowMs: number): string {
  const flag = argv.indexOf("--since");
  if (flag === -1) {
    return new Date(nowMs - defaultWindowDays * dayMs).toISOString().slice(0, 10);
  }
  const value = argv[flag + 1];
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(usageText);
  }
  return value;
}

export function run(argv: Array<string>): void {
  const nowMs = Date.now();
  const since = parseSince(argv, nowMs);
  const repoRoot = mainCheckoutPath();
  const receipts = readReceipts(repoRoot).filter((receipt) => receipt.startedAt >= since);
  console.log(formatReport(receipts));
  console.log(formatSlugBlock(repoRoot, nowMs));
}
