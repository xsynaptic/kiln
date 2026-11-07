export type PrState = "CLOSED" | "MERGED" | "OPEN";

export interface BdAnswer {
  status: number;
  stderr: string;
  stdout: string;
}

export interface FakeIssue {
  assignee: string;
  awaitId?: string;
  awaitType?: string;
  createdAt: string;
  id: string;
  issueType: "gate" | "task";
  priority: number;
  startedAt?: string;
  status: string;
  title: string;
  updatedAt: string;
}

interface FakeComment {
  author: string;
  created_at: string;
  text: string;
}

interface FakeStore {
  blockers: Map<string, Set<string>>;
  comments: Map<string, Array<FakeComment>>;
  issues: Map<string, FakeIssue>;
  nextId: number;
  prState: (prNumber: number) => PrState | undefined;
}

interface Call {
  actor: string;
  flags: Map<string, string>;
  positional: Array<string>;
  store: FakeStore;
}

type Handler = (call: Call) => BdAnswer;

const booleanFlags = new Set(["--claim", "--json"]);

function parseArgs(args: Array<string>): { flags: Map<string, string>; positional: Array<string> } {
  const flags = new Map<string, string>();
  const positional: Array<string> = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const equals = arg.indexOf("=");
    if (!arg.startsWith("--")) {
      positional.push(arg);
    } else if (equals !== -1) {
      flags.set(arg.slice(0, equals), arg.slice(equals + 1));
    } else if (booleanFlags.has(arg)) {
      flags.set(arg, "true");
    } else {
      flags.set(arg, args[index + 1] ?? "");
      index += 1;
    }
  }
  return { flags, positional };
}

function ok(stdout = ""): BdAnswer {
  return { status: 0, stderr: "", stdout };
}

function fail(status: number, stderr: string): BdAnswer {
  return { status, stderr, stdout: "" };
}

function json(value: unknown): BdAnswer {
  return ok(JSON.stringify(value));
}

// bd writes timestamps to the second
function bdNow(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

function issueJson(issue: FakeIssue): Record<string, unknown> {
  return {
    assignee: issue.assignee === "" ? undefined : issue.assignee,
    await_id: issue.awaitId,
    await_type: issue.awaitType,
    created_at: issue.createdAt,
    id: issue.id,
    issue_type: issue.issueType,
    priority: issue.priority,
    started_at: issue.startedAt,
    status: issue.status,
    title: issue.title,
    updated_at: issue.updatedAt,
  };
}

// The installed bd answers a create to the microsecond, though every later read is to the second
function createdJson(issue: FakeIssue): Record<string, unknown> {
  return { ...issueJson(issue), created_at: issue.createdAt.replace("Z", ".000000Z") };
}

function insert(store: FakeStore, fields: Omit<FakeIssue, "createdAt" | "id" | "updatedAt">): FakeIssue {
  const now = bdNow();
  const issue: FakeIssue = { ...fields, createdAt: now, id: `fake-${String(store.nextId)}`, updatedAt: now };
  store.nextId += 1;
  store.issues.set(issue.id, issue);
  return issue;
}

function touch(issue: FakeIssue, fields: Partial<FakeIssue>): void {
  Object.assign(issue, fields, { updatedAt: bdNow() });
}

function gatesBlocking(store: FakeStore, beadId: string): Array<FakeIssue> {
  return [...(store.blockers.get(beadId) ?? [])].flatMap((gateId) => {
    const gate = store.issues.get(gateId);
    return gate === undefined ? [] : [gate];
  });
}

function isBlocked(store: FakeStore, beadId: string): boolean {
  return gatesBlocking(store, beadId).some((gate) => gate.status === "open");
}

function addComment(store: FakeStore, id: string, author: string, text: string): void {
  const list = store.comments.get(id) ?? [];
  list.push({ author, created_at: bdNow(), text });
  store.comments.set(id, list);
}

function readyIssues(store: FakeStore): Array<FakeIssue> {
  return [...store.issues.values()]
    .filter((issue) => issue.issueType === "task" && issue.status === "open" && !isBlocked(store, issue.id))
    .toSorted((left, right) => left.priority - right.priority || left.createdAt.localeCompare(right.createdAt));
}

function guardMismatch(issue: FakeIssue, expected: string | undefined): string | undefined {
  if (expected === undefined || issue.assignee === expected) {
    return undefined;
  }
  return `assignee mismatch: ${issue.id} is held by "${issue.assignee}", expected "${expected}"`;
}

function withIssue(call: Call, index: number, action: (issue: FakeIssue) => BdAnswer): BdAnswer {
  const id = call.positional[index] ?? "";
  const issue = call.store.issues.get(id);
  if (issue === undefined) {
    return fail(1, `Issue ${id} not found`);
  }
  return action(issue);
}

function claim(issue: FakeIssue, actor: string): void {
  touch(issue, { assignee: actor, startedAt: issue.startedAt ?? bdNow(), status: "in_progress" });
}

function close(call: Call): BdAnswer {
  return withIssue(call, 0, (issue) => {
    const open = gatesBlocking(call.store, issue.id).filter((gate) => gate.status === "open");
    if (open.length > 0) {
      return fail(
        1,
        `cannot close blocked issue: ${issue.id} is blocked by [${open.map((gate) => gate.id).join(", ")}]`,
      );
    }
    if (issue.assignee !== "" && issue.assignee !== call.actor) {
      return fail(1, `cannot close ${issue.id}: assignee is "${issue.assignee}", actor is "${call.actor}"`);
    }
    touch(issue, { status: "closed" });
    return ok(`✓ Closed ${issue.id}`);
  });
}

function create(call: Call): BdAnswer {
  const created = insert(call.store, {
    assignee: "",
    issueType: "task",
    priority: Number(call.flags.get("--priority") ?? "2"),
    status: "open",
    title: call.positional[0] ?? "",
  });
  return call.flags.get("--json") === "true" ? json(createdJson(created)) : ok(`✓ Created issue: ${created.id}`);
}

function dependencies(call: Call): BdAnswer {
  const { flags, positional, store } = call;
  const id = positional[1] ?? "";
  if (flags.get("--direction") === "up") {
    const blocked = [...store.issues.values()].filter((issue) => store.blockers.get(issue.id)?.has(id) === true);
    return json(blocked.map((issue) => ({ ...issueJson(issue), dependency_type: "blocks" })));
  }
  return json(gatesBlocking(store, id).map((gate) => ({ ...issueJson(gate), dependency_type: "blocks" })));
}

function list({ flags, store }: Call): BdAnswer {
  const assignee = flags.get("--assignee");
  const statuses = flags.get("--status")?.split(",");
  const isParentQuery = flags.has("--parent");
  const listed = [...store.issues.values()].filter(
    (issue) =>
      issue.issueType === "task" &&
      !isParentQuery &&
      (assignee === undefined || issue.assignee === assignee) &&
      (statuses === undefined ? issue.status !== "closed" : statuses.includes(issue.status)),
  );
  return json(listed.map((issue) => issueJson(issue)));
}

function ready({ actor, flags, store }: Call): BdAnswer {
  if (flags.get("--claim") !== "true") {
    return json(readyIssues(store).map((issue) => issueJson(issue)));
  }
  const next = readyIssues(store).find((issue) => issue.assignee === "");
  if (next === undefined) {
    return json([]);
  }
  claim(next, actor);
  return json([issueJson(next)]);
}

function unclaim(call: Call): BdAnswer {
  return withIssue(call, 0, (issue) => {
    const mismatch = guardMismatch(issue, call.flags.get("--if-assignee"));
    if (mismatch !== undefined) {
      return fail(1, `Error unclaiming ${issue.id}: ${mismatch}`);
    }
    touch(issue, { assignee: "", status: "open" });
    delete issue.startedAt;
    const reason = call.flags.get("--reason");
    if (reason !== undefined) {
      addComment(call.store, issue.id, call.actor, reason);
    }
    return ok(`✓ Unclaimed ${issue.id}`);
  });
}

function update(call: Call): BdAnswer {
  return withIssue(call, 0, (issue) => {
    const { actor, flags } = call;
    const mismatch = guardMismatch(issue, flags.get("--if-assignee"));
    if (mismatch !== undefined) {
      return fail(13, `Error updating ${issue.id}: ${mismatch}`);
    }
    if (flags.get("--claim") === "true") {
      if (issue.assignee !== "" && issue.assignee !== actor) {
        return fail(1, `Error updating ${issue.id}: issue already claimed: already assigned to "${issue.assignee}"`);
      }
      claim(issue, actor);
    }
    const status = flags.get("--status");
    const assignee = flags.get("--assignee");
    touch(issue, {
      ...(status === undefined ? {} : { status }),
      ...(assignee === undefined ? {} : { assignee }),
    });
    return ok(`✓ Updated issue: ${issue.id}`);
  });
}

function createGate({ flags, store }: Call): BdAnswer {
  const blocked = flags.get("--blocks") ?? "";
  if (!store.issues.has(blocked)) {
    return fail(1, `Issue ${blocked} not found`);
  }
  const awaitType = flags.get("--type") ?? "";
  const awaitId = flags.get("--await-id");
  const created = insert(store, {
    assignee: "",
    awaitType,
    issueType: "gate",
    priority: 2,
    status: "open",
    title: `Gate: ${awaitType}${awaitId === undefined ? "" : ` ${awaitId}`}`,
    ...(awaitId === undefined ? {} : { awaitId }),
  });
  store.blockers.set(blocked, new Set([...(store.blockers.get(blocked) ?? []), created.id]));
  return flags.get("--json") === "true" ? json(createdJson(created)) : ok(`✓ Created gate ${created.id}`);
}

// bd gate check closes a merged PR's gate and only reports one closed unmerged
function checkPrGates({ store }: Call): BdAnswer {
  const lines: Array<string> = [];
  for (const issue of store.issues.values()) {
    if (issue.issueType !== "gate" || issue.awaitType !== "gh:pr" || issue.status !== "open") {
      continue;
    }
    const state = store.prState(Number(issue.awaitId));
    if (state === "MERGED") {
      touch(issue, { status: "closed" });
      lines.push(`✓ ${issue.id}: resolved (PR #${issue.awaitId ?? ""} merged)`);
    } else if (state === "CLOSED") {
      lines.push(`✗ ${issue.id}: ESCALATE PR #${issue.awaitId ?? ""} closed without merge`);
    }
  }
  return ok(lines.join("\n"));
}

function listGates({ store }: Call): BdAnswer {
  const open = [...store.issues.values()].filter((issue) => issue.issueType === "gate" && issue.status === "open");
  // The installed bd prints null, not [], when no gate is open
  return json(open.length === 0 ? null : open.map((issue) => issueJson(issue)));
}

function resolveGate(call: Call): BdAnswer {
  return withIssue(call, 1, (issue) => {
    touch(issue, { status: "closed" });
    return ok(`✓ Gate resolved: ${issue.id}`);
  });
}

const gateHandlers: Record<string, Handler> = {
  check: checkPrGates,
  create: createGate,
  list: listGates,
  resolve: resolveGate,
};

const handlers: Record<string, Handler> = {
  close,
  comment: (call) =>
    withIssue(call, 0, (issue) => {
      addComment(call.store, issue.id, call.actor, call.positional[1] ?? "");
      return ok(`✓ Comment added to ${issue.id}`);
    }),
  comments: (call) => withIssue(call, 0, (issue) => json(call.store.comments.get(issue.id) ?? [])),
  create,
  dep: dependencies,
  gate: (call) => {
    const handler = gateHandlers[call.positional[0] ?? ""];
    return handler === undefined ? fail(1, `the fake bd has no gate ${call.positional[0] ?? ""}`) : handler(call);
  },
  list,
  ready,
  show: (call) => withIssue(call, 0, (issue) => json([issueJson(issue)])),
  unclaim,
  update,
};

// An in-memory bd answering the subcommands dispatch calls, with the refusals the installed bd gives
export function createFakeBd(prState: (prNumber: number) => PrState | undefined) {
  const store: FakeStore = { blockers: new Map(), comments: new Map(), issues: new Map(), nextId: 1, prState };

  function run(args: Array<string>): BdAnswer {
    const { flags, positional } = parseArgs(args);
    const [subcommand = "", ...rest] = positional;
    const handler = handlers[subcommand];
    if (handler === undefined) {
      return fail(1, `the fake bd has no ${subcommand}`);
    }
    return handler({ actor: flags.get("--actor") ?? "", flags, positional: rest, store });
  }

  return {
    createBead: (title: string) =>
      insert(store, { assignee: "", issueType: "task", priority: 2, status: "open", title }).id,
    gatesBlocking: (beadId: string) => gatesBlocking(store, beadId),
    issues: store.issues,
    run,
  };
}

export type FakeBd = ReturnType<typeof createFakeBd>;

export function spawnSyncAgainst(fake: FakeBd) {
  return (command: string, args: ReadonlyArray<string> = []) => {
    if (command !== "bd") {
      throw new Error(`the fake bd was asked to run ${command}`);
    }
    const { status, stderr, stdout } = fake.run([...args]);
    return { output: [null, stdout, stderr], pid: 0, signal: null, status, stderr, stdout };
  };
}
