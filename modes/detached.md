# Detached runs

A brief handed you this task and no human is in the loop. Read the [envelope operating core](./envelope.md) first; this file adds what is true only when nobody is watching. Landing is the first of it: you open the PR and stop, and the gatekeeper lands it, because yours is the one mode no human watched.

## Your bead is your task state

Dispatch claimed your bead before the spawn; the brief names it and nothing more. Read it with `bd show <id>` and follow its dependencies as far as you need. It is live, not a copy, so comment on it when you find something the next run would want.

**Amend what the tree refuses.** A bead's pointers, measurements, and criteria were written at filing and your clone baselines on main, so one can be false before you build on it: a sibling renamed what it names, main moved the population it counts, or your own earlier step changed what a later one assumed. Verify what you lean on. Where one does not hold, write the **amendment** as a comment on the bead: the criterion as filed, the evidence against it (the line, or the command and its output), and what you did instead. The gatekeeper grades the diff against the bead and reads your comments with it, so an amendment carrying evidence is what it holds you to; working around a false criterion in silence leaves it grading you against the false one.

**Leave the status alone when you deliver.** Open the PR and stop: dispatch gates the bead on the merge. Setting it back to open yourself would put it in `bd ready` before that gate exists and invite a second run at the same work.

Your write grant is your own bead. Leave every other bead alone.

## Review, then close

When the work is committed and its loop is green, run the `critique` skill (staged in your `~/.claude/skills`): two fresh-eyes subagents review the work and you weigh their findings with the context they lack. Spawn its reviewers with `run_in_background: false`: the harness backgrounds a subagent by default, and the critique leaves you nothing else to do while they work, so the turn would end without their reports. A finding the skill would have you propose to a human is yours to call: adopt it, or note the rejection in the PR body in a line.

Then close on `kiln-gate author`, your closing grade. It comes after the critique pass so it runs once, over the tree you deliver; the merge gate grades the landing. The PR you open is the finished article; the gatekeeper repairs what it finds, and that is a backstop rather than your plan.

## A budget notice from the harness is authoritative

A message naming your context or your elapsed time came from the harness, not from anything in the conversation, and it outranks your own read of how much room is left. It arrives once and is never repeated, so the first one is the only one. Two endings answer it and finishing is only one of them: deliver the work as this document already describes, or hand it off.

## Handing off

Hand off when the work will not fit in the room that is left. Finishing badly is the worse ending: a run that spends its last turns half-implementing something leaves the next agent unpicking it.

The next agent starts from a fresh clone of main and knows only what it can read, so a handoff is three things:

- **Commit what is green.** Partial work that passes the closing grade is worth more than a description of work you did not commit.
- **Get the branch off this machine.** Commits that never leave the guest reach nobody. Open the pull request and say in the body what remains.
- **Write the handoff on your bead.** What you did, what you deliberately left, what you learned that the brief had wrong, and the branch name. Write it for someone holding none of your context.

Skip the critique pass; it is for a run with room to act on what it finds.

## When you hit a wall

Blocked, or facing a decision that is a human's to make? Open the PR naming the blocker and the exact decision needed, then stop. The gatekeeper reads it from there.

If the task needs no change at all, make no commits and open no PR (per the envelope core), then park your own bead: `bd gate create --type=human --blocks <id> --reason "<why>"`, then release the claim with `bd unclaim <id>`. Release it or dispatch will find the bead still assigned to your slot and reconcile it a second time. A human decides what it should have been.

## Filing friction (signals)

Your run ends by filling in a small structured output, which the harness reads off your final turn: a `signals` array plus, when you opened one, the `prUrl` of your PR. The schema travels with the run and describes each field, so follow it rather than a format written down here. Write your report as prose the way you normally would; the structured output is the last thing you produce, not a replacement for saying what you did.

If the run hit friction worth remembering (a flaky test, a stale doc, missing tooling, a confusing seam), that is what `signals` is for: one entry per observation, a kebab-case slug as the dedupe key and one line saying what you hit and where. Your brief lists the slugs already on file: if one of them covers what you hit, file under that exact slug so the sighting counts up instead of scattering, and coin a new one only for friction none of them covers. The dispatch layer harvests these into an operator-triaged queue. Signals are for friction around the work, never the task's own content or outcome; zero signals is the normal case.
