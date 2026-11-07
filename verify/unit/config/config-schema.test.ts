import { describe, expect, it } from "vitest";

import { kilnConfigSchema } from "#src/config/config-schema.ts";

const valid = {
  gates: { author: "make check", merge: "make ci" },
  identity: {
    cloneDirName: "sample",
    githubRepo: "acme/sample",
    machineUser: {
      email: "1+sample-agent@users.noreply.github.com",
      name: "sample-agent",
    },
    projectName: "sample",
  },
  projectDoc: "AGENTS.md",
  slots: {
    devPorts: { DOCS_PORT: 5173, SERVER_PORT: 3000 },
  },
};

function withGates(gates: Record<string, unknown>) {
  return { ...valid, gates: { ...valid.gates, ...gates } };
}

function withSlots(slots: Record<string, unknown>) {
  return { ...valid, slots: { ...valid.slots, ...slots } };
}

describe("kilnConfigSchema", () => {
  it("accepts a descriptor without guest or slot settings and defaults them", () => {
    const parsed = kilnConfigSchema.parse({ ...valid, slots: undefined });
    expect(parsed.guest).toEqual({ globalPackages: [], hostLinks: [], mcpServers: [] });
    expect(parsed.slots).toEqual({
      devPorts: {},
      max: 8,
      resetVolumes: [],
      vm: { cpus: 4, diskGib: 60, memoryGib: 6 },
    });
    expect(parsed.gates).toEqual({ author: "make check", env: {}, merge: "make ci", verdictFiles: {} });
  });

  it("names the clone after the repository unless the descriptor says otherwise", () => {
    const { cloneDirName: _, ...identity } = valid.identity;
    expect(kilnConfigSchema.parse({ ...valid, identity }).identity.cloneDirName).toBe("sample");
    const renamed = { ...valid, identity: { ...identity, githubRepo: "acme/other-repo" } };
    expect(kilnConfigSchema.parse(renamed).identity.cloneDirName).toBe("other-repo");
    expect(kilnConfigSchema.parse(valid).identity.cloneDirName).toBe("sample");
  });

  it("defaults dispatch to Opus alone and holds the reviewer inside the allowlist", () => {
    expect(kilnConfigSchema.parse(valid).dispatch).toEqual({
      models: ["opus"],
      reviewModel: "opus",
      runCeilingMinutes: 360,
    });
    const outside = { ...valid, dispatch: { models: ["sonnet"], reviewModel: "opus" } };
    expect(() => kilnConfigSchema.parse(outside)).toThrow(/reviewModel must be one of dispatch.models/);
    expect(() => kilnConfigSchema.parse({ ...valid, dispatch: { models: [] } })).toThrow();
  });

  it("defaults the slot cap to the namespace ceiling and rejects out-of-range caps", () => {
    expect(kilnConfigSchema.parse(withSlots({ max: 2 })).slots.max).toBe(2);
    expect(kilnConfigSchema.parse(valid).slots.max).toBe(8);
    expect(() => kilnConfigSchema.parse(withSlots({ max: 0 }))).toThrow();
    expect(() => kilnConfigSchema.parse(withSlots({ max: 9 }))).toThrow();
  });

  it("accepts an mcp server entry and rejects shell-unsafe args", () => {
    const server = {
      args: ["-y", "some-mcp@^1.0.0", "--executablePath", "{{CHROME_BIN}}"],
      command: "npx",
      name: "some-mcp",
    };
    const withServer = { ...valid, guest: { mcpServers: [server] } };
    expect(kilnConfigSchema.parse(withServer).guest.mcpServers).toEqual([server]);
    const unsafe = { ...valid, guest: { mcpServers: [{ ...server, args: ['"; rm -rf /"'] }] } };
    expect(() => kilnConfigSchema.parse(unsafe)).toThrow();
    const badName = { ...valid, guest: { mcpServers: [{ ...server, name: "Bad Name" }] } };
    expect(() => kilnConfigSchema.parse(badName)).toThrow();
  });

  it("takes clone-relative verdict paths and rejects absolute or shell-unsafe ones", () => {
    const files = { "check.json": ".git/gate/check.json", "verdict.json": "../verdict.json" };
    expect(kilnConfigSchema.parse(withGates({ verdictFiles: files })).gates.verdictFiles).toEqual(files);
    expect(() => kilnConfigSchema.parse(withGates({ verdictFiles: { "a.json": "/etc/passwd" } }))).toThrow();
    expect(() => kilnConfigSchema.parse(withGates({ verdictFiles: { "a.json": "a.json; rm -rf ~" } }))).toThrow();
  });

  it("rejects a host link that would break out of its guest shell line or read as a flag", () => {
    for (const link of ["data; rm -rf ~", "-", "-rf"]) {
      expect(() => kilnConfigSchema.parse({ ...valid, guest: { hostLinks: [link] } })).toThrow();
    }
  });

  it("takes a gate env and rejects a name or value that would break out of its export line", () => {
    const env = { JOBS: "1", TOOL_CACHE_DIR: ".cache/tool-1.2" };
    expect(kilnConfigSchema.parse(withGates({ env })).gates.env).toEqual(env);
    for (const hostile of [{ JOBS: "1; rm -rf ~" }, { JOBS: "$(id)" }, { JOBS: "" }, { "JOBS=1; id; X": "1" }]) {
      expect(() => kilnConfigSchema.parse(withGates({ env: hostile }))).toThrow();
    }
  });

  it("rejects a reset volume that would break out of its guest shell line or read as a flag", () => {
    for (const hostile of ["db; rm -rf ~", "--rmi", ""]) {
      expect(() => kilnConfigSchema.parse(withSlots({ resetVolumes: [hostile] }))).toThrow();
    }
  });

  it("takes a ranged npm spec as a global package and rejects one that would break out of its shell line", () => {
    const ranged = { ...valid, guest: { globalPackages: ["@acme/cli@^1.2.0"] } };
    expect(kilnConfigSchema.parse(ranged).guest.globalPackages).toEqual(["@acme/cli@^1.2.0"]);
    const hostile = { ...valid, guest: { globalPackages: ["cli; rm -rf ~"] } };
    expect(() => kilnConfigSchema.parse(hostile)).toThrow();
  });

  it("rejects dev ports that collide mod 1000", () => {
    const colliding = withSlots({ devPorts: { APP_PORT: 4000, SERVER_PORT: 3000 } });
    expect(() => kilnConfigSchema.parse(colliding)).toThrow(/distinct mod 1000/);
  });

  it("rejects a malformed repo slug and a non-semver pin", () => {
    const badRepo = { ...valid, identity: { ...valid.identity, githubRepo: "not-a-slug" } };
    expect(() => kilnConfigSchema.parse(badRepo)).toThrow();
    const badPin = { ...valid, guest: { pins: { gitleaks: "latest" } } };
    expect(() => kilnConfigSchema.parse(badPin)).toThrow();
  });
});
