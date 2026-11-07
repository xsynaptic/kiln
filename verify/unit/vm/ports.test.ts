import { describe, expect, it } from "vitest";

import { agentPortBlock, agentSlotFromName, agentSlotNames, pinEnvPorts } from "#src/vm/ports.ts";

describe("agentSlotFromName", () => {
  it("accepts every slot name in the canonical list", () => {
    for (const name of agentSlotNames) {
      expect(agentSlotFromName(name)).toBeDefined();
    }
    expect(agentSlotFromName("kiln-1")).toBe(1);
  });

  it("rejects anything else", () => {
    expect(agentSlotFromName("kiln-0")).toBeUndefined();
    expect(agentSlotFromName("kiln-9")).toBeUndefined();
    expect(agentSlotFromName("kiln-10")).toBeUndefined();
    expect(agentSlotFromName("other")).toBeUndefined();
    expect(agentSlotFromName("kiln-")).toBeUndefined();
  });
});

describe("agentPortBlock", () => {
  const slots = agentSlotNames.map((name) => agentSlotFromName(name)).filter((slot) => slot !== undefined);

  it("never hands two slots, or a slot and the main checkout, the same port", () => {
    const mainPorts = Object.values(agentPortBlock(0).ports);
    const slotPorts = slots.flatMap((slot) => Object.values(agentPortBlock(slot).ports));
    const allPorts = [...mainPorts, ...slotPorts];
    expect(new Set(allPorts).size).toBe(allPorts.length);
  });

  it("keeps every block below the ephemeral range either side allocates from", () => {
    for (const slot of slots) {
      for (const port of Object.values(agentPortBlock(slot).ports)) {
        expect(port).toBeLessThan(32_768);
      }
    }
  });
});

describe("pinEnvPorts", () => {
  const block = {
    offset: 1,
    ports: { APP_PORT: 5300, DOCS_PORT: 5200, SERVER_PORT: 5100 },
  };

  it("appends the node-server pins and touches nothing else", () => {
    const content = ["POSTGRES_PORT=5433", "DATABASE_URL=postgres://sample:sample@localhost:5433/sample", ""].join(
      "\n",
    );
    const pinned = pinEnvPorts(content, block);
    expect(pinned).toContain("POSTGRES_PORT=5433");
    expect(pinned).toContain("localhost:5433/sample");
    expect(pinned).toContain(`SERVER_PORT=${String(block.ports.SERVER_PORT)}`);
    expect(pinned).toContain(`DOCS_PORT=${String(block.ports.DOCS_PORT)}`);
    expect(pinned).toContain(`APP_PORT=${String(block.ports.APP_PORT)}`);
  });

  it("drops host-side lines for the pinned keys so the pin wins", () => {
    const content = ["SERVER_PORT=4000", "POSTGRES_PORT=5433", ""].join("\n");
    const pinned = pinEnvPorts(content, block);
    expect(pinned).not.toContain("SERVER_PORT=4000");
    expect(pinned).toContain(`SERVER_PORT=${String(block.ports.SERVER_PORT)}`);
    expect(pinned.match(/^SERVER_PORT=/gm)).toHaveLength(1);
  });
});
