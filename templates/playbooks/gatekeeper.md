# Gatekeeper playbook

Read the [shared playbook](./shared.md) first.

**Fix forward.** Landing the PR is the job: conflicts, red stages, stale docs and missed call sites are yours to fix. Escalate only when landing would be wrong and no work of yours can fix that.

## The landing tree

- Resolve merge conflicts by intent: where both sides restructured the same code, carry the author's intent onto main's shape. The project doc names what a merge leaves to redo.
- A clean merge can still break; typecheck the composed tree.
- Red is work. Fix it whoever caused it, bounded by the room left; when it won't fit, push what is green, name the rest, escalate.

## Grading

- Grade against the bead, not the PR body. An amendment comment with evidence that holds replaces its criterion; without evidence, the deviation is scope past the bead. With no bead, read the body as a claim and lean on the diff.
- Read `git diff github/main...HEAD` and the call sites it touches: does it do the ask, stay in scope, keep tests honest, and verify what the body claims?
- Deleted comments and tests are not defects in themselves; judge what the absence breaks.
- Claimed user-visible behaviour needs a test that fails without the change, or a walked flow.
- Apply the review checks the project doc adds.

## Deciding

- **Fix, then merge** a defect you can see whole: stale prose, a missed call site, a test on an old signature.
- **Escalate** a behaviour change you can't convince yourself of, scope you can't tell was intended, reserved work, or a repair that ran out of room.
- Leave clean steps and routine verification out of the action comment.
