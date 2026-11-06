import { restrictedSyntax } from "#lint/restricted-syntax.ts";
import { RuleTester } from "#support/rule-tester.ts";

const ruleTester = new RuleTester();

const options = [{ message: "no star exports", selector: "ExportAllDeclaration" }, "TSEnumDeclaration"];

ruleTester.run("restricted-syntax", restrictedSyntax, {
  invalid: [
    {
      code: `export * from "./sample.ts";`,
      errors: [{ data: { message: "no star exports" }, messageId: "restricted" }],
      options,
    },
    {
      code: `enum Status { Draft }`,
      errors: [{ data: { message: "`TSEnumDeclaration` is not allowed." }, messageId: "restricted" }],
      options,
    },
  ],
  valid: [{ code: `export { sample } from "./sample.ts";`, options }],
});
