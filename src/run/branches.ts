import { isIncludedIn } from "remeda";

export const branchTypes = ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "test"] as const;

export function isBranchType(value: string): boolean {
  return isIncludedIn(value, branchTypes);
}

export function typeFromTitle(title: string): string {
  const type = /^([a-z]+)(?:\([^)]*\))?!?:/.exec(title)?.[1];
  return type !== undefined && isBranchType(type) ? type : "feat";
}
