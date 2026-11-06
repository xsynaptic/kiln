import net from "node:net";
import { describe, expect, it } from "vitest";

import { isPortInUse } from "#src/shared/net.ts";

describe("isPortInUse", () => {
  it("reports true while a listener holds the port, false once it closes", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected an AddressInfo from an ephemeral bind");
    }
    const { port } = address;

    try {
      expect(await isPortInUse(port)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }

    expect(await isPortInUse(port)).toBe(false);
  });
});
