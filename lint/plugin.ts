import { localMockSpread } from "./local-mock-spread.ts";
import { restrictedSyntax } from "./restricted-syntax.ts";
import { suppressionReason } from "./suppression-reason.ts";

export default {
  rules: {
    "local-mock-spread": localMockSpread,
    "restricted-syntax": restrictedSyntax,
    "suppression-reason": suppressionReason,
  },
};
