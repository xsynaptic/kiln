# @xsynaptic/kiln

## 0.2.0

### Minor Changes

- Split mode docs into staged `contracts/` and consumer-owned playbooks (`playbooks` field, templates in `templates/`); a no-change run reports it and reconcile parks the bead; skills and the slot stub stage at every launch.
- Ship the gate protocol as `kiln-gate`: locked `author` and `merge` gates with tree-keyed verdicts, `wait`, and a `push` hook that scans secrets and replays verdicts.

### Patch Changes

- Harden `kiln-gate`: a stale lock is taken over by one gate only, even after a gate dies mid-takeover, reaping signals a process group only while its recorded leader is still alive, and the push scan reads `remoteSha..localSha` whenever the old tip is in the clone.
