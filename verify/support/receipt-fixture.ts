import type { RunReceipt } from "#src/run/receipts.ts";

export function testReceipt(overrides: Partial<RunReceipt>): RunReceipt {
  return {
    branch: "feat/x",
    endedAt: "2026-09-12T08:10:00.000Z",
    slot: "kiln-1",
    startedAt: "2026-09-12T08:00:00.000Z",
    stopReason: "completed",
    transcriptDir: "transcripts/kiln-1-x",
    ...overrides,
  };
}
