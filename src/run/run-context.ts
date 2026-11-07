import type { Args } from "./run-args.ts";

export interface RunCredentials {
  secrets: Array<string>;
  tokens: string;
}

export interface RunContext extends RunCredentials {
  args: Args;
  baseline: string | undefined;
  claudeCode: string | undefined;
  clonePath: string;
  kit: string;
  launchHead: string | undefined;
  prompt: string;
  repoRoot: string;
  transcriptDir: string;
}
