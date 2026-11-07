# Envelope contract

You are in a sandboxed clone in an isolated VM, as an attended session ([attended.md](./attended.md)), a detached run ([detached.md](./detached.md)) or a gatekeeper review ([gatekeeper.md](./gatekeeper.md)). This file is their shared half. The host staged these contracts outside the clone, so no branch can rewrite them.

Before working, read the project doc `{{projectDoc}}` and your role's playbook (named in your launch prompt, or in `~/.claude/CLAUDE.md` when attended) with `git show github/main:<path>`, and every repo file they link the same way. A contract wins over a playbook, the project doc and the repo's `CLAUDE.md`.

Work that changes something leaves as a pull request; your mode's contract says who lands it. A session that changes nothing owes no PR. A task that needs no change gets no commits and no PR.

## The sandbox

`origin` and `github` both point at the repository on GitHub. `host-ro` is the read-only host mount the clone was seeded from, never a remote. `gh` carries a repo-scoped token.

## Branch and push

- Work on the `<type>/<slug>` branch you were given, never `main`.
- Push with `git push github HEAD:<branch>`. Never `--no-verify`, never force-push.
- The pre-push hook scans for secrets, then replays a green verdict for the tip of each pushed ref or runs the author gate. A verdict replays only for a tree that was committed and clean when it ran, so gate the commit you push. On a secret-scan finding, remove the secret (rewriting unpushed history if needed) and push again.
- A push touching `.github/workflows/` is refused: the token lacks workflow scope. Commit everything else and put the workflow YAML in the PR body.

## The gate

Your mode's contract names your gate, `kiln-gate author` or `kiln-gate merge`. It grades the committed tree and records a verdict the push hook replays. Run it through `kiln-gate`, never the command underneath, with a generous timeout.

## Opening the PR

Kiln reads these back:

- `gh pr create --repo {{githubRepo}} --head <branch>`.
- End the body with `Run: $KILN_RUN` on its own line, and `Bead: <id>` when your brief names one.
- Write the body to a file outside the clone (`mktemp`) and pass `--body-file`, never `--body`; a file in the clone keeps a verdict from replaying. A quoted heredoc also stops `$KILN_RUN` expanding, so append the `Run:` line after it closes and read the file back to check it holds the value.

## Finish in the foreground

Detached or reviewing, your turn is the run's whole life; nothing re-invokes you. Carry the task to the final report in one unbroken turn.

- Spawn subagents with `run_in_background: false` unless you have other work while they run; a backgrounded subagent's report lands after your turn ends.
- Background a command only when you have other work in hand, with the timeout it would get in the foreground; without one it stops at ten minutes and a gate stopped there leaves no verdict.
- Wait on a backgrounded gate with `kiln-gate wait`, in the foreground, under a timeout that covers the gate. Never build the wait yourself, and never start a second gate over a live one.

## Never

- Rewrite history on GitHub, destroy or migrate production data, touch credentials, spend money, or make anything public. Surface it and stop.
- Write task state beyond your mode's grant and [beads.md](./beads.md).
- Stand up a task-state store. `bd` reaches the host's store over a forward; `bd dolt start` builds an empty second store. A `bd` that cannot connect is a broken run: say so and escalate.
- Commit secrets or credentials.
- Run a tool across the whole repo in one process, or raise `NODE_OPTIONS` above the slot's {{slots.vm.memoryGib}} GiB (no swap: overruns are a SIGKILL). Run the narrower form the project doc names and say so in the PR.
- Print the environment (`env`, `printenv`, `ps e`); it holds credentials and transcripts persist.
