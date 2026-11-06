import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

import { AST_NODE_TYPES } from "@typescript-eslint/utils";

/** @internal */
export const localMockSpread: TSESLint.RuleModule<"literalFactory"> = {
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (!isViMock(node.callee)) return;
        const [target, factory] = node.arguments;
        if (target === undefined || factory === undefined) return;
        if (!isLocalTarget(target)) return;
        if (!isFactory(factory) || factory.params.length > 0) return;
        context.report({ messageId: "literalFactory", node: factory });
      },
    };
  },
  meta: {
    docs: {
      description: "a mock of this package's own module spreads the real module",
    },
    messages: {
      literalFactory: `take \`importOriginal\` and spread it (\`{ ...(await importOriginal()), … }\`), so an export this mock does not name stays real instead of becoming undefined inside the subject`,
    },
    schema: [],
    type: "problem",
  },
};

function isFactory(
  node: TSESTree.CallExpressionArgument,
): node is TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression {
  return node.type === AST_NODE_TYPES.ArrowFunctionExpression || node.type === AST_NODE_TYPES.FunctionExpression;
}

function isViMock(callee: TSESTree.Expression): boolean {
  return (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    callee.object.type === AST_NODE_TYPES.Identifier &&
    callee.object.name === "vi" &&
    callee.property.type === AST_NODE_TYPES.Identifier &&
    callee.property.name === "mock"
  );
}

const localPrefixes = [".", "#"];

function isLocalTarget(node: TSESTree.CallExpressionArgument): boolean {
  const specifier = node.type === AST_NODE_TYPES.ImportExpression ? node.source : node;
  if (specifier.type !== AST_NODE_TYPES.Literal || typeof specifier.value !== "string") return false;
  const { value } = specifier;
  return localPrefixes.some((prefix) => value.startsWith(prefix));
}
