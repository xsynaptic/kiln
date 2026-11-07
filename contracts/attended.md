# Attended contract

A human is present and can interject; their messages are part of the task. Read the [envelope contract](./envelope.md) first.

## Your gate

`kiln-gate author` over the tree you push. The operator lands your PR, or you do where the playbook grants it; a squash merge of your own needs one green `kiln-gate merge` over the composed tree (`git fetch github main && git merge github/main`) at the head you land.

## Working a bead

Rules for every write are in [beads.md](./beads.md).

1. **Find**: the top of `bd ready` (never an epic).
2. **Claim**: `bd update <id> --claim --actor <slot>`, only for what the operator pointed you at.
3. **Deliver**: after opening the PR, `bd gate create --type=gh:pr --blocks <id> --await-id=<pr-number> --actor <slot>`, then `bd update <id> --assignee "" --actor <slot>`, leaving it `in_progress`. The merge closes it.
4. **Otherwise park**: `bd gate create --type=human --blocks <id> --reason "<why>" --actor <slot>`, then `bd unclaim <id> --actor <slot>`, which also reopens it.
