import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

type Restriction = string | { message?: string; selector: string };

/** @internal */
export const restrictedSyntax: TSESLint.RuleModule<"restricted", Array<Restriction>> = {
  create(context) {
    const listeners: TSESLint.RuleListener = {};
    for (const restriction of context.options) {
      const { message, selector } =
        typeof restriction === "string" ? { message: undefined, selector: restriction } : restriction;
      listeners[selector] = (node: TSESTree.Node) => {
        context.report({
          data: { message: message ?? `\`${selector}\` is not allowed.` },
          messageId: "restricted",
          node,
        });
      };
    }
    return listeners;
  },
  meta: {
    docs: {
      description: "a syntax the house style bans is named by its selector",
    },
    messages: { restricted: "{{message}}" },
    schema: {
      items: {
        oneOf: [
          { type: "string" },
          {
            additionalProperties: false,
            properties: {
              message: { type: "string" },
              selector: { type: "string" },
            },
            required: ["selector"],
            type: "object",
          },
        ],
      },
      type: "array",
    },
    type: "problem",
  },
};
