interface GateVerdict {
  dirty: boolean;
  exit: number;
  finishedAt: string;
  name: string;
  startedAt: string;
  tree: string;
}

interface PushState {
  headTree: string;
  isDirty: boolean;
  pushedTrees: ReadonlyArray<string>;
  verdicts: ReadonlyArray<GateVerdict>;
}

type ReplayDecision =
  { kind: "pass" } | { kind: "refuse"; reason: "dirty" | "not-checked-out"; trees: Array<string> } | { kind: "run" };

export function replayDecision(state: PushState): ReplayDecision;
