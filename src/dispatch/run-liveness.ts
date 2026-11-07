export const launchGraceMinutes = 10;

export function isPastRunCeiling(launchedAt: string, ceilingMinutes: number, nowMs: number): boolean {
  const startedMs = Date.parse(launchedAt);
  if (Number.isNaN(startedMs)) {
    return false;
  }
  return nowMs - startedMs > ceilingMinutes * 60_000;
}
