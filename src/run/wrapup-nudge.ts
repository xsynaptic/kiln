import path from "node:path";

import type { RunNudge } from "./receipts.ts";

import { parseJson } from "../shared/lenient-json.ts";
import { sshCaptureSafe } from "../vm/vm.ts";
import { runNudgeSchema } from "./receipts.ts";

export const wrapupHookFile = "wrapup-hook.mjs";

export const nudgeMarkerFile = "blind-nudged";

export function nudgeRecord(profile: string, workDir: string): RunNudge | undefined {
  const raw = sshCaptureSafe(profile, `cat ${path.posix.join(workDir, nudgeMarkerFile)}`);
  if (raw === undefined || raw === "") {
    return undefined;
  }
  return runNudgeSchema.safeParse(parseJson(raw)).data;
}

export function wrapupSettings(hookPath: string, markerPath: string): string {
  return JSON.stringify({
    hooks: {
      PostToolUse: [
        {
          hooks: [{ command: `node ${hookPath} ${markerPath}`, timeout: 10, type: "command" }],
          matcher: "*",
        },
      ],
    },
  });
}

export function wrapupHookSource(): string {
  return path.join(import.meta.dirname, wrapupHookFile);
}
