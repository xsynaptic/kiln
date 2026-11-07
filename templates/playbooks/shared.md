# Shared playbook

## Scope

- Do exactly what the task asks; every changed line traces to it.
- When a choice isn't clear-cut and nobody is there to ask, make the smaller call and note it in the PR body.

## Verify

- Done is one green closing grade on your final commit. It stops at its first red phase: fix it in the project's loop, then rerun.
- Run the loop through the repo's scripts, never the bare tool.
- Rerun a red test file alone before investigating it.
- For a user-visible flow that the task asks you to check, or that is easy to get subtly wrong, walk it in the real app and say what you walked.
- Commit as soon as the loop is green.
- Run `git commit` and anything chained to it unpiped; a pipe hides a failed status.

## The PR

- Commits and the title are short and why-first.
- Match the repo's PR template by hand. The body is why, what the diff doesn't show, and how you verified. Short is fine.

## Reserved for a human

List actions this project reserves beyond kiln's here.
