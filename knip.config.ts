import type { KnipConfig } from "knip";

export default {
  entry: [
    // The bin points at dist/, so knip can't trace it back to this file
    "src/kiln.cli.ts!",
    // Copied into a guest and run there as a Claude Code hook
    "src/run/wrapup-hook.mjs!",
    // Staged into a guest and run there as `kiln-gate`
    "src/run/kiln-gate.mjs!",
    // Imported by the plugin oxlint loads by path, which production mode reads as a development file
    "lint/!(plugin).ts!",
    "verify/support/descriptor.ts",
  ],
  ignore: ["src/run/kiln-gate-replay.d.mts"],
  ignoreBinaries: ["caffeinate", "colima", "bd", "dolt", "gitleaks", "herdr", "pgrep"],
  includeEntryExports: true,
  project: ["**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}!", "!verify/**!"],
} satisfies KnipConfig;
