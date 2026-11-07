export const gateNames = ["author", "merge"];

export function replayDecision({ headTree, isDirty, pushedTrees, verdicts }) {
  const proven = new Set(verdicts.filter((verdict) => isReplayable(verdict)).map((verdict) => verdict.tree));
  const pushed = new Set(pushedTrees);
  const unproven = [];
  for (const tree of pushed) {
    if (!proven.has(tree)) {
      unproven.push(tree);
    }
  }
  if (unproven.length === 0) {
    return { kind: "pass" };
  }
  if (unproven.some((tree) => tree !== headTree)) {
    return { kind: "refuse", reason: "not-checked-out", trees: unproven };
  }
  if (isDirty) {
    return { kind: "refuse", reason: "dirty", trees: unproven };
  }
  return { kind: "run" };
}

function isReplayable(verdict) {
  return (
    gateNames.includes(verdict.name) &&
    verdict.exit === 0 &&
    verdict.dirty === false &&
    typeof verdict.tree === "string"
  );
}
