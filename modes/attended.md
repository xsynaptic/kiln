# Attended sessions

A human launched or attached to this session and can interject at any time. Read the [envelope operating core](./envelope.md) first; this file adds the grants that exist because a human is present. Landing is one of them: you squash-merge your own PR once its gates are green, the same as a host session, because the operator is here to see it. No gatekeeper follows you, so your closing grade is the landing's own. Compose the tree the squash will land first (`git fetch github main`, then `git merge github/main`), then run `kiln-gate merge` on it, once, before the squash merge.

## Steering

Operator messages are part of the task, mid-run steering included. When you are blocked, or hit a decision that is a human's to make, ask and wait; never guess, and never fall back to a draft PR while there is a person to ask.

## Task state: working a bead live

You own the whole lifecycle of any bead you work: a detached run has dispatch to find, claim, and gate for it, and here you do all of that yourself. Store-wide policy (what beads is for, filing, retry) is [beads.md](./beads.md); the lifecycle is:

1. **Find**: `bd ready` lists claimable work (epics are grouping records, never worked directly). "Pick up the next task" means the top of that list.
2. **Claim before working**: `bd update <id> --claim --actor <slot>` (your sandbox slot name). The claim drops the bead from `bd ready`, so dispatch cannot also launch it. Claim only what the operator pointed you at or approved.
3. **Work**: the bead's description, design, and acceptance criteria are the task; the envelope core governs the work and the delivery.
4. **Gate on delivery**: after opening the PR, run `bd gate create --type=gh:pr --blocks <id> --await-id=<pr-number>`, then release the claim (`bd update <id> --assignee "" --actor <slot>`) and leave the status at `in_progress`. The merge closes the bead; nothing else needs doing. Why both halves matter is [beads.md](./beads.md)'s retry note.
5. **Anything else parks it**: `bd gate create --type=human --blocks <id> --reason "<why>"`, then release the claim with `bd unclaim <id> --actor <slot>`. The gate holds it off `bd ready` until a human runs `bd gate resolve <gate-id>`; why `unclaim` rather than `update` is [beads.md](./beads.md)'s outcome rule.

Carry `--actor` on every write; without it bd falls back to whatever the environment or the checkout's config names (the order is in [beads.md](./beads.md)).
