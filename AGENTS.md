# AGENTS.md

Kiln is developed in host sessions in this checkout. No agent loop runs on kiln itself.

## Commands

- `pnpm check` reports, `pnpm fix` mutates. Run `fix` once after a chunk of work, not after every edit
- `check` is green end to end, so anything it reports is yours
- `pnpm test:integration` (against the installed `bd`) and `pnpm check-models` (TLA+ through Docker) stay out of `check`; run them when a change touches what they cover
- Before changing a source file, `grep -rl <path> verify/` shows whether a formal model names it and needs updating too
- `dist/` mirrors `src/`, because modules find the package root and the guest scripts (`wrapup-hook.mjs`, `kiln-gate.mjs`) by relative path
- `pnpm changeset` records a change for the next release. Committing, tagging and publishing are the operator's

## Nothing project-specific enters the tree

Kiln knows a consuming project only through that project's `kiln.config.ts`. No file here names or describes a consumer: not its name, its scripts, its apps, its ports, or an anecdote from operating it. Fixtures use neutral placeholders (`acme/sample`, `packages/sample`). When kiln needs a project's behaviour, that becomes a descriptor field.

A boundary test enforces this against `.claude/denylist`, a gitignored file of forbidden names, one per line. The test skips when the file is absent, so keep the file in place while working here.

## Comments

A comment survives only where deleting it would let a competent reader introduce a bug: a security constraint on an interpolated value, an external tool's misbehaviour, an ordering that looks wrong and is not. Rationale for a design choice does not belong in a comment. A survivor is one line, sentence case, no trailing period.

## Runtime prose

`modes/` and `skills/` ship in the package and are staged into every slot, so they point at nothing outside the package.
