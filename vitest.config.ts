import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    allowOnly: false,
    env: { KILN_CONFIG: path.join(import.meta.dirname, "verify/support/descriptor.ts") },
    include: ["verify/unit/**/*.test.ts"],
  },
});
