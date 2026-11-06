import { describe, expect, it } from "vitest";

import { beadsEnvLines, parseDoltRootPassword, roleSql } from "#src/vm/beads.ts";

describe("parseDoltRootPassword", () => {
  const credentials = ["[127.0.0.1:3306]", "password=other", "", "[127.0.0.1:3307]", "password=ours", ""].join("\n");

  it("takes the password from the section for this server", () => {
    expect(parseDoltRootPassword(credentials, 3307)).toBe("ours");
    expect(parseDoltRootPassword(credentials, 3306)).toBe("other");
  });

  it("has no password for a server the file does not cover", () => {
    expect(parseDoltRootPassword(credentials, 9999)).toBeUndefined();
    expect(parseDoltRootPassword("", 3307)).toBeUndefined();
  });

  it("ignores a password written before any section", () => {
    expect(parseDoltRootPassword("password=loose\n[127.0.0.1:3307]\n", 3307)).toBeUndefined();
  });
});

describe("roleSql", () => {
  it("creates the role, re-sets its password, and grants it the bd database", () => {
    const sql = roleSql("hunter2");
    expect(sql).toContain("CREATE USER IF NOT EXISTS 'agent_rw'@'%' IDENTIFIED BY 'hunter2';");
    expect(sql).toContain("ALTER USER 'agent_rw'@'%' IDENTIFIED BY 'hunter2';");
    expect(sql).toContain("GRANT ALL PRIVILEGES ON `bd`.* TO 'agent_rw'@'%';");
  });

  it("escapes a quote in the password rather than closing the literal early", () => {
    expect(roleSql("a'b")).toContain("IDENTIFIED BY 'a''b';");
  });
});

describe("beadsEnvLines", () => {
  it("reads the password from stdin and points bd at the forwarded server", () => {
    const [readLine, exportLine] = beadsEnvLines(false);
    expect(readLine).toBe("IFS= read -r BEADS_DOLT_PASSWORD");
    expect(exportLine).toContain("BEADS_DOLT_SERVER_MODE=1");
    expect(exportLine).toContain("BEADS_DOLT_SERVER_PORT=3307");
    expect(exportLine).toContain("BEADS_DOLT_SERVER_USER=agent_rw");
  });

  it("leaves BD_READONLY unset for a run that may write its own bead", () => {
    expect(beadsEnvLines(false).join(" ")).not.toContain("BD_READONLY");
  });

  it("exports BD_READONLY for a run granted no task-state write", () => {
    expect(beadsEnvLines(true)[1]).toContain(" BD_READONLY=1 ");
  });
});
