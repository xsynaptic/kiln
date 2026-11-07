---
name: critique
description: Fresh-eyes review of the pending work by two isolated subagents on opposing lenses, then weigh their findings and act. Use when asked for a critique, a second opinion, or a review of the current changes before delivering them.
---

# Critique

Two **fresh-eyes** reviewers (subagents whose contexts never saw this session) review the pending work by opposing methods; you weigh what they find. Isolation is the whole point: send them only the prompt below and let them discover the work from the diff.

**One pass per body of work.** A second round resurfaces findings you already rejected rather than catching new ones, so run another only when a human asks.

## Steps

1. **Find the target.** Uncommitted changes, or with a clean tree on a work branch, the branch diff. A clean tree on the default branch has nothing to review: say so and stop.

2. **Spawn both reviewers concurrently**, as two `general-purpose` Agent calls in one message: Reviewer A on `haiku`, Reviewer B on `opus`. Each gets the shared preamble with its own lens appended, verbatim.

3. **Weigh every finding** with the context they lack. Agreement between the two is a confidence signal, not a duplicate.
   - Apply clear wins (unambiguous bugs, cleanups), then re-run the relevant check.
   - Propose anything carrying a tradeoff (architecture, scope, design) to the human.
   - Reject a wrong finding with a one-line reason.

4. **Report your assessment**: a line per finding, accepted with what you did or rejected with why. The raw reports stay internal.

## The reviewer prompt

Shared preamble:

> You are an expert reviewer with no prior knowledge of this work. Review every uncommitted change in this repo as a demanding senior engineer would.
>
> Find the changes yourself: `git status`, `git diff HEAD` for tracked edits, and read untracked files directly. If the tree is clean, the work is already committed on this branch: review the branch's full diff against the default branch instead (`git diff <default>...HEAD`). Read the diff plus the immediate call sites and definitions you need to judge each change in context; what looks fine in isolation can be wrong against the code around it. Don't tour the whole repo.
>
> Each finding will be weighed and either fixed or rejected with a reason, so make it count: rank by real impact, justify why it matters, and separate confidence from speculation. Report genuine problems; skip style nits and praise.
>
> Return prose grouped by severity. Per finding: `file:line`, what's wrong, why it matters. Cap the report at your five most impactful findings, a tight paragraph each; a short report is a stronger signal than a long one. Review only; change nothing.

Reviewer A, append:

> **Assume this change is subtly broken, and prove it.** Work bottom-up, line by line. Find the input, state, or event sequence that makes it misbehave: edge cases, boundary values, unhandled errors, null/empty/overflow, races, off-by-one, wrong assumptions about callers or data. Name the trigger and the wrong result. Flag dead or redundant logic, and anything the change implies should exist but doesn't.

Reviewer B, append:

> **Assume it works today, and ask whether it should exist as written.** Work top-down from intent and structure, not line by line. Imagine inheriting this in six months: what will you curse? Wrong or leaky abstractions, scope creep, coupling, tech debt, missing tests, design omissions in the broader system. Lead with fit and maintainability. Name a correctness bug only if it's unavoidable; don't go bug-hunting, that's the other reviewer's job.
