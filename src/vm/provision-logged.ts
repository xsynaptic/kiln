import { closeSync, openSync, readFileSync } from "node:fs";

import { spawnKiln } from "../shared/kiln-cli.ts";
import { agentRunsPath, ensureDir, timestampSlug } from "../shared/run-artifacts.ts";

const failureTailLines = 15;

// A child process, because colima and the guest scripts write straight to the inherited output, which this sends to a log
export async function provisionSlotLogged(repoRoot: string, slotName: string): Promise<void> {
  ensureDir(agentRunsPath(repoRoot, "provisions"));
  const logPath = agentRunsPath(repoRoot, "provisions", `${slotName}-${timestampSlug()}.log`);
  console.log(`  provisioning ${slotName} (log: ${logPath})`);
  const startedAt = Date.now();
  const fd = openSync(logPath, "a");
  let exitCode: null | number;
  try {
    exitCode = await new Promise<null | number>((resolve, reject) => {
      const child = spawnKiln(["new", slotName], {
        cwd: repoRoot,
        stdio: ["ignore", fd, fd],
      });
      child.on("error", reject);
      child.on("close", resolve);
    });
  } finally {
    closeSync(fd);
  }
  if (exitCode !== 0) {
    const tail = readFileSync(logPath, "utf8").trimEnd().split("\n").slice(-failureTailLines).join("\n");
    throw new Error(`provisioning ${slotName} failed (exit ${String(exitCode)}); full log: ${logPath}\n${tail}`);
  }
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(`  ${slotName} provisioned in ${String(seconds)}s`);
}
