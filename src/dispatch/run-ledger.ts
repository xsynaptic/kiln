import type { RunReceipt } from "../run/receipts.ts";

import { runReceiptSchema, settlementOf } from "../run/receipts.ts";
import { parseJson } from "../shared/lenient-json.ts";

export function deliveredPrUrl(receipt: RunReceipt): string | undefined {
  return settlementOf(receipt) === "delivered" ? receipt.prUrl : undefined;
}

export function hasReceiptSince(receipts: Array<RunReceipt>, slot: string, launchedAt: string): boolean {
  return receipts.some((receipt) => receipt.slot === slot && Date.parse(receipt.startedAt) >= Date.parse(launchedAt));
}

// Compared as numbers, because as strings '.' sorts before 'Z' and a receipt from the same second would be dropped
export function latestReceiptForBead(
  receipts: Array<RunReceipt>,
  beadId: string,
  since?: string,
): RunReceipt | undefined {
  const sinceMs = since === undefined ? undefined : new Date(since).getTime();
  return receipts.findLast(
    (receipt) =>
      receipt.bead === beadId &&
      (sinceMs === undefined || Number.isNaN(sinceMs) || new Date(receipt.startedAt).getTime() >= sinceMs),
  );
}

export function parseReceipts(text: string): Array<RunReceipt> {
  const receipts: Array<RunReceipt> = [];
  for (const parsed of parseJsonLines(text)) {
    const receipt = runReceiptSchema.safeParse(parsed);
    if (receipt.success) {
      receipts.push(receipt.data);
    }
  }
  return receipts;
}

export function strandedPrUrl(receipt: RunReceipt): string | undefined {
  return settlementOf(receipt) === "delivered" ? undefined : receipt.prUrl;
}

function* parseJsonLines(text: string): Generator {
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) {
      continue;
    }
    const parsed = parseJson(line);
    if (parsed !== undefined) {
      yield parsed;
    }
  }
}
