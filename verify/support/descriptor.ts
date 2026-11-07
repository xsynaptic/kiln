import { defineKilnConfig } from "#src/config/config-schema.ts";

/** @public reached only by the loader's dynamic import */
export default defineKilnConfig({
  gates: {
    author: "npm run verify",
    merge: "npm run verify:all",
  },
  identity: {
    cloneDirName: "sample",
    gatekeeperLogin: "sample-gatekeeper",
    githubRepo: "acme/sample",
    machineUser: {
      email: "1+sample-agent@users.noreply.github.com",
      name: "sample-agent",
    },
    projectName: "sample",
  },
  projectDoc: "docs/agents.md",
  slots: {
    devPorts: {
      APP_PORT: 4300,
      DOCS_PORT: 4200,
      SERVER_PORT: 4100,
    },
  },
});
