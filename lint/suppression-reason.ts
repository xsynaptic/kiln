import type { TSESLint } from "@typescript-eslint/utils";

const directive = /^\s*(?:eslint|oxlint)-disable(?:-next-line|-line)?(?:\s|$)/;

/** @internal */
export const suppressionReason: TSESLint.RuleModule<"missing"> = {
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (!directive.test(comment.value)) continue;
          const reason = comment.value.split(/\s--\s/, 2)[1] ?? "";
          if (reason.trim() !== "") continue;
          context.report({ loc: comment.loc, messageId: "missing" });
        }
      },
    };
  },
  meta: {
    docs: {
      description: "a suppression comment says why it is there",
    },
    messages: {
      missing: "say why after ` -- `: a suppression with no reason cannot be told from one that has outlived it",
    },
    schema: [],
    type: "problem",
  },
};
