# Beads: task-state policy

Beads (`bd`) is the **agent dispatch queue and nothing more**. Ideas, plans, and decisions live in the project's own docs; beads holds only scoped work headed for a sandbox run.

**Upstream docs: <https://beads.gascity.com/llms.txt>** (fetchable index). Read them before building anything that looks like queue mechanics; `bd --help` outranks them for the installed version. This file is policy on top of that tool, never a description of what it can do.

**Text-only work is not bead-eligible.** A bead needs a runtime surface and a checkable acceptance; work whose whole deliverable is prose (a research memo, an options analysis, a decision record, documentation, an open decision) has neither. It runs interactively and stages in the project's backlog; its output (a decision, a scoped backlog entry) is what spawns build beads later. A session directed to work that hits one **raises it** ("research, a decision, or a discussion, not bead-ready") instead of filing it. Docs produced as a byproduct of a code bead are fine; the exclusion applies only when text is the entire deliverable.

**Filing is authorization.** Dispatch takes `bd ready` verbatim (epics excepted: grouping records, never launched), so a bead is filed when the work should run, not before. Filing is a conscious operator act on an explicit go-ahead, never a side effect of a session noticing work.

**Any two ready slices can run at once.** Where two slices can genuinely collide (two schema migrations off one parent, say), the gate is what catches it, not the queue.

**Retry is a human command, not machinery**, with one narrow exception: a run the API dropped mid-stream (`failed:api_error`) before it committed anything requeues on its own and spends none of the bead's attempts, since that is weather, not a verdict on the work. A bead gets five of those free; past five they spend the bead's attempts like any other death, so an outage that outlasts the crank's hold parks the bead once those are gone instead of relaunching it without end. One that died holding commits parks like any other run with unpushed work.

**Every run outcome leaves the bead somewhere, and coordination scaffolding outside bd names the decision that necessitates it.** A delivered bead waits at `in_progress` with its claim released, behind a `gh:pr` gate, until its PR merges; then dispatch closes it (and the parent epic, when that was the last child). The gate is what holds it out of `bd ready`, and the released claim is what keeps reconcile, which walks by assignee, from reading it as a run that died. Any other outcome parks the bead behind a **human gate** (`bd gate create --type=human`) carrying the reason and releases its claim with `bd unclaim`, which also sets it back to `open`, because `bd ready` skips an `in_progress` bead whatever its gates say. The gate alone then holds it out of the queue, so unparking is `bd gate resolve <gate-id>`, a deliberate act, and the bead returns to the queue on its own.

**An escalation is a park too**, which makes `bd gate list` the one inbox of work waiting on a human, each entry naming what it waits on. A gatekeeper thumbs-down writes a label and a comment and no task state, so dispatch is what parks the bead behind it, carrying the doubt verbatim; two dead gatekeeper runs at one head end the same way. A park takes the bead out of the machinery's hands but keeps its `gh:pr` gate, so what a human does with the PR is still what settles the bead.

**Every session reaches the store, or does not start; the grant is what differs.** A launch that cannot prove the store is reachable refuses rather than running blind, in every mode, because a session working from its brief alone cannot see its acceptance criteria or its comment history and nothing in the PR shows the gap. A detached task run works the bead dispatch claimed for it and writes only to that one ([detached.md](./detached.md)); dispatch still owns launching and reconciles a run that dies before it can report. An attended session, or a host session directed at a bead, claims and gates its own bead ([attended.md](./attended.md)). A gatekeeper review run reads the bead its PR claims ([gatekeeper.md](./gatekeeper.md)). Writes within the mode's grant are legitimate; the Dolt history and `bd backup` keep every one auditable and reversible. The grant is beads-only: the VM boundary is untouched, so a permissionless agent still cannot write a byte outside its clone.

**Nothing reads task state from git.** The `.beads/issues.jsonl` export is on-demand only (`bd export`, gitignored, for interchange), so filing needs no commit or push before dispatching. What a bead _cites_ is the exception: a run whose plan lives only in an unpushed commit has to dig it out of history before it can start, so the task document goes to `main` before the beads that point at it.

## Sharp edges

- Never `bd admin compact` (irreversible; it deletes closed-issue content), `bd prune`, or `bd purge`.
- Never `bd setup claude --global` (it rewrites `~/.claude`).
- Attribute every write to a role actor (the operator, dispatch, a slot) with the `--actor <name>` flag, never to a person, since the store's history outlives the session. A write without the flag falls back to `BEADS_ACTOR`, then the checkout's config `actor:`, and `bd config set actor` is inert.
- Never `bd reclaim`. Nothing heartbeats a claim, so every claim outlives its five-minute lease and `bd show` reports it expired; a reap would reopen live runs' beads for a second launch. The assignee is what holds a claim here.
- `bd init` and some `bd config` writes auto-commit the `.beads` files, sweeping up whatever else was staged. Soft-reset (`git reset --soft HEAD~1`) after one, then commit only what you meant to.
