export const launchGraceMinutes = 10;

export function isPastRunCeiling(launchedAt: string, ceilingHours: number, nowMs: number): boolean {
  const startedMs = Date.parse(launchedAt);
  if (Number.isNaN(startedMs)) {
    return false;
  }
  return nowMs - startedMs > ceilingHours * 3_600_000;
}
