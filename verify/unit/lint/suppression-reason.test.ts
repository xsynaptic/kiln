import { suppressionReason } from "#lint/suppression-reason.ts";
import { RuleTester } from "#support/rule-tester.ts";

// A fixture's directive names a rule that never runs here
const ruleTester = new RuleTester({
  linterOptions: { reportUnusedDisableDirectives: "off" },
});

ruleTester.run("suppression-reason", suppressionReason, {
  invalid: [
    {
      code: "// oxlint-disable-next-line no-console\nconsole.log(1);",
      errors: [{ messageId: "missing" }],
    },
    {
      code: "/* eslint-disable no-console */\nconsole.log(1);",
      errors: [{ messageId: "missing" }],
    },
    {
      code: "console.log(1); // oxlint-disable-line no-console -- ",
      errors: [{ messageId: "missing" }],
    },
  ],
  valid: [
    "// oxlint-disable-next-line no-console -- the CLI's only output\nconsole.log(1);",
    "/* eslint-disable no-console -- the CLI's only output */\nconsole.log(1);",
    "/* oxlint-enable no-console */",
    "// Suppressions are spelled oxlint-disable in a module\nconst sample = 1;",
  ],
});
