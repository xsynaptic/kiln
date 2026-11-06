import { localMockSpread } from "#lint/local-mock-spread.ts";
import { RuleTester } from "#support/rule-tester.ts";

const ruleTester = new RuleTester();

ruleTester.run("local-mock-spread", localMockSpread, {
  invalid: [
    {
      code: `vi.mock("./bd-client.ts", () => ({ bd: vi.fn() }));`,
      errors: [{ messageId: "literalFactory" }],
    },
    {
      code: `vi.mock(import("#src/shared/proc.ts"), () => ({ capture: vi.fn() }));`,
      errors: [{ messageId: "literalFactory" }],
    },
    {
      code: `vi.mock("./bd-client.ts", async function () { return { bd: vi.fn() }; });`,
      errors: [{ messageId: "literalFactory" }],
    },
  ],
  valid: [
    {
      code: `vi.mock(import("#src/queue/bd-client.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  bd: vi.fn(),
}));`,
    },
    { code: `vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));` },
    { code: `vi.mock("./bd-client.ts");` },
  ],
});
