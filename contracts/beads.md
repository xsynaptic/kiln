# Beads contract

Every `bd` write you make:

- Carries `--actor <name>` naming a role (the operator, dispatch, a slot), never a person.
- Is never `bd reclaim`: nothing heartbeats a claim, so every claim reads as expired and a reap would reopen live runs.
- Is never `bd admin compact`, `bd prune`, `bd purge`, or `bd setup claude --global`.
