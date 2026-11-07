import perfectionist from "eslint-plugin-perfectionist";
import unicorn from "eslint-plugin-unicorn";
import { defineConfig } from "oxlint";

const coreRules = [
  "for-direction",
  "no-async-promise-executor",
  "no-case-declarations",
  "no-compare-neg-zero",
  "no-cond-assign",
  "no-constant-binary-expression",
  "no-constant-condition",
  "no-control-regex",
  "no-debugger",
  "no-delete-var",
  "no-dupe-else-if",
  "no-duplicate-case",
  "no-empty-character-class",
  "no-empty-pattern",
  "no-empty-static-block",
  "no-ex-assign",
  "no-extra-boolean-cast",
  "no-fallthrough",
  "no-global-assign",
  "no-invalid-regexp",
  "no-irregular-whitespace",
  "no-loss-of-precision",
  "no-misleading-character-class",
  "no-nonoctal-decimal-escape",
  "no-prototype-builtins",
  "no-regex-spaces",
  "no-self-assign",
  "no-shadow-restricted-names",
  "no-sparse-arrays",
  "no-unassigned-vars",
  "no-unexpected-multiline",
  "no-unsafe-finally",
  "no-unsafe-optional-chaining",
  "no-unused-labels",
  "no-unused-private-class-members",
  "no-useless-assignment",
  "no-useless-backreference",
  "no-useless-catch",
  "no-useless-escape",
  "no-var",
  "prefer-const",
  "prefer-rest-params",
  "prefer-spread",
  "preserve-caught-error",
  "require-yield",
  "use-isnan",
  "valid-typeof",
];

const typescriptRules = [
  "adjacent-overload-signatures",
  "ban-tslint-comment",
  "class-literal-property-style",
  "consistent-generic-constructors",
  "consistent-indexed-object-style",
  "consistent-type-assertions",
  "consistent-type-definitions",
  "no-array-constructor",
  "no-confusing-non-null-assertion",
  "no-duplicate-enum-values",
  "no-dynamic-delete",
  "no-empty-function",
  "no-empty-object-type",
  "no-explicit-any",
  "no-extra-non-null-assertion",
  "no-extraneous-class",
  "no-inferrable-types",
  "no-invalid-void-type",
  "no-misused-new",
  "no-namespace",
  "no-non-null-asserted-nullish-coalescing",
  "no-non-null-asserted-optional-chain",
  "no-non-null-assertion",
  "no-require-imports",
  "no-this-alias",
  "no-unnecessary-type-constraint",
  "no-unsafe-declaration-merging",
  "no-unsafe-function-type",
  "no-unused-expressions",
  "no-useless-constructor",
  "no-wrapper-object-types",
  "prefer-as-const",
  "prefer-for-of",
  "prefer-function-type",
  "prefer-literal-enum-member",
  "prefer-namespace-keyword",
  "triple-slash-reference",
  "unified-signatures",
];

const typeAwareRules = [
  "await-thenable",
  "dot-notation",
  "no-array-delete",
  "no-base-to-string",
  "no-confusing-void-expression",
  "no-deprecated",
  "no-duplicate-type-constituents",
  "no-floating-promises",
  "no-for-in-array",
  "no-generated-empty-object-type",
  "no-implied-eval",
  "no-meaningless-void-operator",
  "no-misused-promises",
  "no-misused-spread",
  "no-mixed-enums",
  "no-redundant-type-constituents",
  "no-unnecessary-boolean-literal-compare",
  "no-unnecessary-condition",
  "no-unnecessary-template-expression",
  "no-unnecessary-type-arguments",
  "no-unnecessary-type-assertion",
  "no-unnecessary-type-conversion",
  "no-unnecessary-type-parameters",
  "no-unsafe-argument",
  "no-unsafe-assignment",
  "no-unsafe-call",
  "no-unsafe-enum-comparison",
  "no-unsafe-member-access",
  "no-unsafe-return",
  "no-unsafe-unary-minus",
  "no-useless-default-assignment",
  "only-throw-error",
  "prefer-find",
  "prefer-includes",
  "prefer-optional-chain",
  "prefer-promise-reject-errors",
  "prefer-reduce-type-parameter",
  "prefer-regexp-exec",
  "prefer-return-this-type",
  "prefer-string-starts-ends-with",
  "related-getter-setter-pairs",
  "require-await",
  "restrict-plus-operands",
  "restrict-template-expressions",
  "return-await",
  "unbound-method",
  "use-unknown-in-catch-callback-variable",
];

function enable(prefix: string, names: Array<string>) {
  return Object.fromEntries(names.map((name) => [`${prefix}${name}`, "error" as const]));
}

function isEnabled(entry: unknown) {
  const severity: unknown = Array.isArray(entry) ? entry[0] : entry;
  return severity !== "off" && severity !== 0;
}

const unicornRules = Object.fromEntries(
  Object.entries(unicorn.configs.recommended.rules ?? {})
    .filter(([name, entry]) => name.startsWith("unicorn/") && isEnabled(entry))
    .map(([name, entry]) => [name.replace("unicorn/", "unicorn-js/"), entry]),
);

export default defineConfig({
  categories: { correctness: "off" },
  env: { builtin: true, node: true },
  globals: { localStorage: "readonly", sessionStorage: "readonly" },
  ignorePatterns: ["node_modules/**", "dist/**"],
  jsPlugins: [
    { name: "kiln", specifier: "./lint/plugin.ts" },
    { name: "perfectionist", specifier: "eslint-plugin-perfectionist" },
    { name: "unicorn-js", specifier: "eslint-plugin-unicorn" },
  ],
  overrides: [
    {
      files: ["**/*.{js,mjs}", "*.config.ts"],
      rules: Object.fromEntries(typeAwareRules.map((name) => [`typescript/${name}`, "off"])),
    },
    {
      // A tool reads its config, and the loader a descriptor, from a default export the module builds by a call
      files: ["*.config.ts", "verify/support/descriptor.ts"],
      rules: { "unicorn-js/no-top-level-side-effects": "off" },
    },
    {
      files: ["**/*.test.ts"],
      rules: {
        "kiln/local-mock-spread": "error",
        "max-lines-per-function": "off",
        "max-statements": "off",
        "unicorn-js/no-top-level-assignment-in-function": "off",
      },
    },
  ],
  plugins: ["import", "typescript"],
  rules: {
    ...enable("", coreRules),
    ...enable("typescript/", typescriptRules),
    ...enable("typescript/", typeAwareRules),
    ...unicornRules,
    ...Object.fromEntries(
      Object.entries(perfectionist.configs["recommended-natural"].rules ?? {}).filter(([, entry]) => isEnabled(entry)),
    ),
    // Ceilings sit at the worst case the code already has, and only ever move down
    complexity: ["warn", { max: 10, variant: "modified" }],
    "import/consistent-type-specifier-style": ["error", "prefer-top-level"],
    "kiln/restricted-syntax": [
      "error",
      {
        message: "Re-export named symbols explicitly; `export *` (barrel star-exports) is banned.",
        selector: "ExportAllDeclaration",
      },
      {
        message:
          "Use an object with `as const` instead of an enum; enums emit runtime code and their nominal typing leaks.",
        selector: "TSEnumDeclaration",
      },
    ],
    "kiln/suppression-reason": "error",
    "logical-assignment-operators": ["error", "never"],
    "max-depth": ["warn", 3],
    "max-lines-per-function": ["warn", { max: 108, skipBlankLines: true, skipComments: true }],
    "max-statements": ["warn", 46],
    "no-empty": ["error", { allowEmptyCatch: true }],
    // Its fixer moves declarations blind to what depends on their order, and eats suppression blocks
    "perfectionist/sort-modules": "off",
    // Its fixer leaves leading comments behind while the arms move under them, so a comment partitions instead
    "perfectionist/sort-union-types": ["error", { order: "asc", partitionByComment: true, type: "natural" }],
    "typescript/array-type": ["error", { default: "generic" }],
    "typescript/ban-ts-comment": ["error", { minimumDescriptionLength: 10 }],
    "typescript/consistent-type-imports": ["error", { fixStyle: "separate-type-imports", prefer: "type-imports" }],
    "typescript/max-params": ["warn", { max: 5 }],
    "typescript/no-unused-vars": [
      "error",
      {
        args: "all",
        argsIgnorePattern: "^_",
        caughtErrors: "all",
        caughtErrorsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      },
    ],
    "typescript/restrict-plus-operands": [
      "error",
      { allowAny: false, allowBoolean: false, allowNullish: false, allowNumberAndString: false, allowRegExp: false },
    ],
    "typescript/restrict-template-expressions": [
      "error",
      {
        allowAny: false,
        allowBoolean: false,
        allowNever: false,
        allowNullish: false,
        allowNumber: false,
        allowRegExp: false,
      },
    ],
    "typescript/return-await": ["error", "error-handling-correctness-only"],
    "unicorn-js/consistent-class-member-order": "off",
    "unicorn-js/consistent-conditional-object-spread": ["error", "ternary"],
    // The inverse of `logical-assignment-operators` above, and its fixer would win a `--fix` pass
    "unicorn-js/logical-assignment-operators": "off",
    "unicorn-js/max-nested-calls": ["error", { max: 3 }],
    "unicorn-js/name-replacements": "off",
    "unicorn-js/no-null": "off",
    // `cond ? [] : [value]` inside flatMap is the house filter-map, and unwrapping one arm would mix an array with a bare value
    "unicorn-js/no-unnecessary-array-flat-map": "off",
    // A fixture helper's parameter names what a caller varies, even while every call passes one value
    "unicorn-js/no-unnecessary-parameters": "off",
    // Its fixer rewrites `() => undefined` to `() => {}`, which no-empty-function then rejects
    "unicorn-js/no-useless-undefined": ["error", { checkArrowFunctionBody: false }],
    "unicorn-js/number-literal-case": ["error", { hexadecimalValue: "lowercase" }],
    "unicorn-js/prefer-combined-guards": "off",
    // Treats `value ?? fallback` as a default parameter, but a default replaces only `undefined` and lets `null` through
    "unicorn-js/prefer-default-parameters": "off",
    // The three below fix to ES2024 and ES2025 APIs that the ES2023 lib does not type
    "unicorn-js/prefer-group-by": "off",
    "unicorn-js/prefer-iterator-to-array": "off",
    "unicorn-js/prefer-promise-with-resolvers": "off",
    "unicorn-js/prefer-ternary": "off",
    "unicorn-js/require-array-sort-compare": "off",
    "unicorn-js/single-line-block-comment-style": "off",
  },
});
