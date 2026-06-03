# Phase 2 ECC migration — deliverable summary

**Date:** 2026-06-03
**Author:** Migration Architect
**Scope:** ADR `2026-05-31-ecc-migration-design.md` §2.2 (Hooks)
**Branch:** `architect/phase-2-hooks-migration`
**Status:** DRAFT — activation deferred to Phase 2.5 (separate PR)

---

## Overview

Phase 2 ports 4 of 5 legacy `.claude/hooks/*.sh` scripts to ECC
v2.0.0-rc.1's JSON matcher format with **stable IDs** and **specific
predicates** (fast-exits on non-target invocations). Per the design ADR,
this PR ships only the **draft registration** and **new script files** —
the live `.claude/settings.json` is **not modified**. Old `.sh` files
remain authoritative until Phase 2.5 activation.

---

## Decision matrix

| # | Legacy hook                       | Phase 2 decision           | ECC stable id                          | Status      |
| - | --------------------------------- | -------------------------- | -------------------------------------- | ----------- |
| 1 | `safety.sh`                       | **Adapt** (specific preds) | `pre:bash:safety`                      | Ported      |
| 2 | `block-production-edits.sh`       | **Keep custom** (port)     | `pre:edit-write:zone-of-write`         | Ported      |
| 3 | `coder-pre-push.sh`               | **Keep custom** (narrowed) | `pre:bash:coder-push-gate`             | Ported      |
| 4 | `coder-progress-marker.sh`        | **Adapt** (kept; spike)    | `post:edit-write:coder-progress`       | Reused as-is |
| 5 | `eslint-feedback.sh`              | **Replace** via eslint MCP | (removed; tracked in `_removed_` blk)  | Strategy doc |

Per-hook references:

- (1) safety:        new `.claude/hooks-ecc/pre-bash-safety.sh`
- (2) zone-of-write: new `.claude/hooks-ecc/pre-edit-write-zone-of-write.sh`
- (3) push-gate:     new `.claude/hooks-ecc/pre-bash-coder-push-gate.sh`
- (4) progress:      legacy `.claude/hooks/coder-progress-marker.sh` reused
- (5) eslint:        no script — replacement strategy in
  `docs/architecture/2026-06-03-phase2-eslint-mcp-replacement.md`

---

## Deliverables in this PR

### New executables (`.claude/hooks-ecc/`)

```
pre-bash-safety.sh                3.0 KB  pre:bash:safety
pre-bash-coder-push-gate.sh       3.2 KB  pre:bash:coder-push-gate
pre-edit-write-zone-of-write.sh   3.0 KB  pre:edit-write:zone-of-write
```

All three:
- Are POSIX-compatible bash, no Node bootstrap (per Architect constraint
  "не имитируй ECC node.js dispatcher").
- Emit ECC-style exit codes (0 = allow, 2 = block) AND legacy Claude Code
  JSON decision body on stdout for compatibility.
- Fast-exit (microseconds) on non-target inputs.
- Carry stable-id header comment matching the JSON registration.

### Draft registration

`.claude/hooks-ecc-draft.json` — NOT loaded by Claude Code. Contains:
- Three PreToolUse entries with stable IDs.
- One PostToolUse entry (`post:edit-write:coder-progress`) reusing the
  legacy `.sh` per spike decision.
- `_meta` block declaring draft status & activation target.
- `_removed_in_phase_2` block documenting the eslint-feedback removal.

### Decision docs

- `2026-06-03-phase2-coder-progress-spike.md`
  Verdict: **Adapt** (keep our hook). Justification: PM recovery contract
  is consumer-distinct from ECC's continuous-learning observer.
  Confidence: HIGH.

- `2026-06-03-phase2-eslint-mcp-replacement.md`
  Verdict: Replace PostToolUse hook with eslint MCP pre-check. Phase 5 will
  delete the `.sh` and update `CLAUDE.md`. Confidence: HIGH.

- `2026-06-03-phase2-smoke-tests.md`
  D1-D4 scenarios documented. **Not executed in this PR** — execution
  scheduled for Phase 2.5 activation PR.

- `2026-06-03-phase2-deliverable.md` (this file).

---

## Activation plan

### Phase 2 (this PR) — preparation only

- Land new scripts + draft JSON + docs.
- Old `.sh` files in `.claude/hooks/` remain **fully authoritative**.
- Live `.claude/settings.json` is **not touched**.
- Verification: CI green, no diff in apps/**, packages/**, settings.json.

### Phase 2.5 (next PR) — activation

1. Edit `.claude/settings.json`:
   - Replace `bash .../hooks/safety.sh` → `bash .../hooks-ecc/pre-bash-safety.sh`
   - Add new entry for `pre-bash-coder-push-gate.sh` (under Bash matcher)
   - Replace `bash .../hooks/block-production-edits.sh` → `bash .../hooks-ecc/pre-edit-write-zone-of-write.sh`
   - Replace matcher `"Edit|Write|NotebookEdit"` with `"Edit|Write|MultiEdit|NotebookEdit"` to align with ECC convention
   - Update the `coder-progress-marker.sh` entry's id-bearing description
   - **Remove** the `eslint-feedback.sh` PostToolUse entry
   - Add a leading `"id"` field to every retained block
2. Run all smoke tests from `2026-06-03-phase2-smoke-tests.md`.
3. Record results in the PR body.
4. Merge if all pass; revert if any fail.

### Phase 5 (cleanup PR)

- `rm .claude/hooks/eslint-feedback.sh`
- Edit `CLAUDE.md` to document MCP-first eslint workflow (per
  eslint-mcp-replacement doc § "CLAUDE.md update").
- Possibly `rm .claude/hooks/safety.sh`, `block-production-edits.sh`,
  `coder-pre-push.sh` IF Phase 2.5 has been stable for ≥ 1 week.
  Keep `coder-progress-marker.sh` (still referenced as the post-edit-write
  hook target in the activated config).

---

## Rollback plan

If ECC hooks misbehave after Phase 2.5 activation:

1. **Immediate:** `git revert <Phase 2.5 PR sha>` — restores
   `.claude/settings.json` pointing at legacy `.sh`. Hooks resume working
   instantly (no cache invalidation).
2. **Diagnostic:** New `.claude/hooks-ecc/` scripts + draft JSON remain in
   repo for inspection (this Phase 2 PR is NOT reverted).
3. **Fix forward:** File a task to edit the offending script in
   `.claude/hooks-ecc/`, re-test via smoke scenarios, re-attempt Phase 2.5
   activation in a fresh PR.

No data loss path: every hook is idempotent / observational; reverting is
safe.

---

## Acceptance criteria for Phase 2.5 activation

- [ ] All smoke tests D1, D1b, D2, D3, D3b, D4 pass (output matches
      "Expected" column).
- [ ] CI green after `.claude/settings.json` swap.
- [ ] Dispatch one Coder task end-to-end (any small task) to confirm:
      - Coder can Edit apps/** from worktree
      - Coder cannot push without ac_verified
      - PM tail of `coder-activity.log` still receives entries
- [ ] Architect cannot Edit apps/** from main repo cwd (manual check).
- [ ] One destructive command (e.g., `rm -rf /etc` dry-run via the
      hook script with stdin echo) returns exit 2.

---

## Open questions for User

1. **Stable id convention** — ECC uses `<lifecycle>:<matcher>:<purpose>`
   (e.g., `pre:bash:dispatcher`). For our `coder-progress-marker`,
   matcher is `Edit|Write|MultiEdit|NotebookEdit`; I chose
   `post:edit-write:coder-progress` (matcher-token style). Acceptable, or
   should we use `post:tools:coder-progress` or
   `post:edit-write-multiedit-notebookedit:coder-progress`?
   **Default if no answer:** keep `post:edit-write:coder-progress`.

2. **Env var `$CLAUDE_AGENT_ID`** — used in `pre-edit-write-zone-of-write.sh`
   as Allow-#2 condition (Coder marker). ECC may or may not propagate
   such an env. If it doesn't, the worktree-cwd check (Allow-#1) still
   covers all current Coder dispatches. **Worth confirming during
   Phase 2.5 smoke tests** — if no agent ever sets `$CLAUDE_AGENT_ID=coder`,
   strip Allow-#2 in a follow-up.

3. **Phase 2.5 timing** — schedule activation PR immediately after this
   merge, or batch with Phase 3 (agents) for fewer PR cycles? Recommend:
   **separate PR, soon** — smaller diff is easier to verify, and Phase 3
   changes touch agent prompts that may depend on the new hooks being
   live.

4. **`coder-progress-marker.sh` rename** — script body is reused unchanged
   but registered under new ECC id. Should we also rename the `.sh` file
   to `post-edit-write-coder-progress.sh` and move into `hooks-ecc/` for
   consistency? Recommend: **no, defer to Phase 5 cleanup**, keep this PR
   minimal.

---

## Confidence

**HIGH** for:
- Decision matrix correctness (per ADR § 2.2)
- Script logic (1-to-1 port of legacy behavior + tightened predicates)
- Activation plan (small, reversible)

**MEDIUM** for:
- Smoke test exit-code expectations (haven't actually executed —
  scheduled for Phase 2.5; ECC PreToolUse `exit 2` vs JSON-decision is
  documented in ECC `hooks/README.md` but may have version-specific
  quirks)
- `$CLAUDE_AGENT_ID` env propagation — needs runtime verification

**Risk if wrong:** caught at Phase 2.5 smoke-test stage, rollback is one
revert.
