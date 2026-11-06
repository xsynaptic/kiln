# Changesets

Record each change with `pnpm changeset`, picking a semver bump, and commit the file it writes alongside the work.

To release, run `pnpm changeset version`, then `pnpm release`, which runs the gate, publishes, and pushes the tags.
