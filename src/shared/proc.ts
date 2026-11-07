import { spawnSync } from "node:child_process";

export function capture(command: string, args: Array<string>, cwd?: string): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...(cwd ? { cwd } : {}),
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} failed`);
  }
  return result.stdout.trim();
}

export function runOrThrow(command: string, args: Array<string>, cwd: string): void {
  const status = run(command, args, cwd);
  if (status !== 0) {
    throw new Error(`${command} exited ${String(status)}`);
  }
}

export function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function run(command: string, args: Array<string>, cwd: string): number {
  return spawnSync(command, args, { cwd, stdio: "inherit" }).status ?? 1;
}
