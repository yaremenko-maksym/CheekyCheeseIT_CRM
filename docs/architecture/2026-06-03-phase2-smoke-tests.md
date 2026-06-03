# Phase 2 smoke tests — D1-D4 scenarios

**Date:** 2026-06-03
**Author:** Migration Architect
**Status:** **Documented, NOT executed.** Execution scheduled for Phase 2.5
activation PR (when `.claude/settings.json` is swapped to point at
`hooks-ecc/`).
**Branch:** `architect/phase-2-hooks-migration`

---

## Scope

These four scenarios validate that the three new ECC-style hook scripts
(`pre-bash-safety.sh`, `pre-bash-coder-push-gate.sh`,
`pre-edit-write-zone-of-write.sh`) behave correctly **before** they are
activated. Each scenario maps to a real-world failure mode the legacy
`.sh` hooks were designed to catch.

Execution model (Phase 2.5):

1. Temporarily activate the ECC hooks in `.claude/settings.json`
   (or invoke the scripts manually via stdin).
2. Run each scenario.
3. Record observed exit code + stderr.
4. Compare against "Expected" column below.
5. If all pass → land activation PR. If any fail → revert, fix, re-test.

---

## D1 — safety hook does NOT block legitimate cleanup

**Hypothesis:** Specific predicates should permit `rm -rf` under well-known
temp paths and only block root-/home-level rm.

**Reproduction:**

```bash
echo '{"tool_input":{"command":"rm -rf /tmp/test-dir"}}' \
  | bash /Users/maksym/Desktop/programming/CheekyCheeseIT_CRM/.claude/hooks-ecc/pre-bash-safety.sh
echo "exit=$?"
```

**Expected:**

- Exit code: `0`
- Stdout: empty
- Stderr: empty

**Pass criteria:** Exit 0, no output. Hook treats `/tmp/...` as safe.

**Fail signal:** Any non-zero exit, any block JSON on stdout.

---

## D1b — safety hook DOES block destructive rm at root

```bash
echo '{"tool_input":{"command":"rm -rf /etc"}}' \
  | bash /Users/maksym/Desktop/programming/CheekyCheeseIT_CRM/.claude/hooks-ecc/pre-bash-safety.sh
echo "exit=$?"
```

**Expected:**

- Exit code: `2`
- Stdout: `{"decision":"block","reason":"Заблокировано safety хуком: rm -rf on root/home path. ..."}`
- Stderr: `[pre:bash:safety] BLOCK: rm -rf on root/home path`

**Pass criteria:** Exit 2 + block JSON.

---

## D2 — Architect (non-Coder) cannot `git push` without ac_verified

**Hypothesis:** Push-gate must block ANY agent on `feature|fix|infra|test`
branches missing `ac_verified:` — irrespective of who's invoking.

**Reproduction:**

```bash
# Setup
git worktree add /tmp/d2-test -b feature/d2-smoke-test origin/main
cd /tmp/d2-test
echo "scratch" > /tmp/d2-test/SCRATCH.md
git add SCRATCH.md
git commit -m "feat: scratch file for D2 smoke test"

# Invoke hook
echo '{"tool_input":{"command":"git push -u origin feature/d2-smoke-test"}}' \
  | bash /Users/maksym/Desktop/programming/CheekyCheeseIT_CRM/.claude/hooks-ecc/pre-bash-coder-push-gate.sh
echo "exit=$?"

# Cleanup
cd -
git worktree remove --force /tmp/d2-test
git branch -D feature/d2-smoke-test
```

**Expected:**

- Exit code: `2`
- Stdout: JSON `{"decision":"block","reason":"🚫 PRE-PUSH BLOCK: ... feature/d2-smoke-test ..."}`
- Stderr: `[pre:bash:coder-push-gate] BLOCK branch=feature/d2-smoke-test (no ac_verified)`

**Pass criteria:** Exit 2, block message includes branch name.

**Fail signal:** Exit 0 (gate is leaky).

---

## D3 — Architect cannot Edit apps/\*\* from main repo cwd

**Hypothesis:** Zone-of-write hook blocks production-code edits unless
inside a `.claude/worktrees/` cwd or escape hatch is present.

**Reproduction:**

```bash
cd /Users/maksym/Desktop/programming/CheekyCheeseIT_CRM   # main repo cwd, NOT worktree
test ! -f .claude/.allow-direct-edits || mv .claude/.allow-direct-edits /tmp/escape-hatch.bak

echo '{"tool_name":"Edit","tool_input":{"file_path":"apps/api/src/test.ts"}}' \
  | bash /Users/maksym/Desktop/programming/CheekyCheeseIT_CRM/.claude/hooks-ecc/pre-edit-write-zone-of-write.sh
echo "exit=$?"

# Restore if needed
test -f /tmp/escape-hatch.bak && mv /tmp/escape-hatch.bak .claude/.allow-direct-edits
```

**Expected:**

- Exit code: `2`
- Stdout: JSON `{"decision":"block","reason":"🚫 PRODUCTION-EDIT BLOCK: попытка править apps/api/src/test.ts ..."}`
- Stderr: `[pre:edit-write:zone-of-write] BLOCK path=apps/api/src/test.ts cwd=...`

**Pass criteria:** Exit 2, block message includes file path.

**Fail signal:** Exit 0 from main-repo cwd.

---

## D3b — Coder worktree CAN Edit apps/\*\*

```bash
git worktree add /tmp/d3b-coder-test -b feature/d3b-test origin/main
cd /tmp/d3b-coder-test   # cwd contains /.claude/worktrees/ — but for worktrees outside .claude/, we test the AGENT_ID path

CLAUDE_AGENT_ID=coder bash -c '
  echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"apps/api/src/test.ts\"}}" \
    | bash /Users/maksym/Desktop/programming/CheekyCheeseIT_CRM/.claude/hooks-ecc/pre-edit-write-zone-of-write.sh
  echo "exit=$?"
'

cd -
git worktree remove --force /tmp/d3b-coder-test
git branch -D feature/d3b-test
```

**Expected:**

- Exit code: `0`
- Stdout: empty
- Stderr: empty

**Pass criteria:** Exit 0 (Coder allowed via env-var path).

**Fail signal:** Exit 2 with block message (Coder being gated incorrectly).

---

## D4 — fast exit on non-target Bash (perf check)

**Hypothesis:** Per dev-flow-rca D3, the legacy push-gate fires on every
Bash call and adds noticeable overhead. The ECC port must fast-exit on
commands that aren't `git push`.

**Reproduction:**

```bash
# Run both push-gate AND safety hooks on a benign command, time them.
time (
  echo '{"tool_input":{"command":"echo hello"}}' \
    | bash /Users/maksym/Desktop/programming/CheekyCheeseIT_CRM/.claude/hooks-ecc/pre-bash-safety.sh
  echo '{"tool_input":{"command":"echo hello"}}' \
    | bash /Users/maksym/Desktop/programming/CheekyCheeseIT_CRM/.claude/hooks-ecc/pre-bash-coder-push-gate.sh
)
```

**Expected:**

- Both exit `0` with no output
- Total real time: < 100 ms on a warm shell (no git calls, no python imports for the push-gate because the `git push` regex fails first)

**Pass criteria:** Both exit 0, no output, sub-100ms.

**Fail signal:** Any output, exit ≠ 0, or > 250 ms (suggests push-gate is running `git rev-parse` on non-target commands).

---

## Execution checklist for Phase 2.5 PR

- [ ] Activate ECC hooks (swap `.claude/settings.json` → point at hooks-ecc/)
- [ ] Run D1 (rm -rf /tmp ok) → record result
- [ ] Run D1b (rm -rf /etc blocked) → record result
- [ ] Run D2 (push without ac_verified blocked) → record result
- [ ] Run D3 (apps edit from main cwd blocked) → record result
- [ ] Run D3b (Coder worktree allowed) → record result
- [ ] Run D4 (fast exit on non-target) → record timing
- [ ] If all pass → keep activation, land PR
- [ ] If any fail → revert `.claude/settings.json`, file fix task, do NOT land
