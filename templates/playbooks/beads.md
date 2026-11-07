# Beads: operator policy

Beads (`bd`) is the dispatch queue and nothing more; ideas, plans and decisions live in the project's docs. Upstream docs are <https://beads.gascity.com/llms.txt>; `bd --help` outranks them for the installed version.

- **Filing is authorization.** Dispatch launches `bd ready` verbatim (epics excepted), so file a bead when the work should run, on an explicit go-ahead.
- **Text-only work is not bead-eligible.** A bead needs a runtime surface and a checkable acceptance. A memo, decision record or documentation runs interactively; a session asked to file one raises it instead.
- **Any two ready slices can run at once.** The gate, not the queue, catches a real collision.
- **Retry is a human command.** Kiln retries a run that delivered nothing once, then parks it. An API drop before any commit requeues free, up to five times.
- **`bd gate list` is the inbox.** Every park and escalation waits there; `bd gate resolve <gate-id>` returns the bead to the queue.
- **Cited docs go to `main` first.** Nothing reads task state from git, but a run reads what a bead cites off `main`.
- **`bd init` and some `bd config` writes auto-commit** whatever is staged. Soft-reset (`git reset --soft HEAD~1`) after one and commit only what you meant to.
