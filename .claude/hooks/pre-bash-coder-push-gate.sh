#!/bin/bash
# ECC stable id: pre:bash:coder-push-gate
# Phase 2 ECC port of legacy .claude/hooks/coder-pre-push.sh.
#
# Purpose: enforce that agent commits carry an `ac_verified:` marker before
# `git push`. Layer C3 fix from docs/architecture/2026-05-23-dev-flow-rca.md
# (D3 cite — narrow matcher: only act on actual `git push` invocations, not
# every Bash call).
#
# ── WHY THE BRANCH RULE IS INVERTED (2026-09-01) ─────────────────────────────
#
# Until today this hook enforced only on `^(feature|fix|infra|test)/`. `feat/`
# was not in that list, and `feat/` is in daily use: 15 merged PRs used it
# (#618, #599, #584, #521, #352, #351, #349, #324, #270, #268, #266, #265,
# #262, #260, #259 — `gh pr list --state merged --json headRefName`), and the
# notifications epic is on it right now. On every one of them this gate was
# silent. It was found by a Coder who noticed the hook had not stopped him,
# not by the hook.
#
# `feat/` was not the only miss, which is the actual point. The same query
# shows merged code arriving on `perf/` (#474, apps/ file), `ci/` (#433, 8
# apps/ files), `docs/` (#613 — 24 files under apps/, including finance dialog
# and cascade-preview logic; #469 — 10 files), plus `refactor/`, `revert/`,
# `chore/`, and the harness's own `worktree-agent-<hash>` branch name (merged
# once, PR head `worktree-agent-af418f7487e736dfb`). An allowlist of "code
# prefixes" was wrong in at least six ways at the moment it was audited, and
# every one of those ways failed SILENTLY — the gate's whole failure mode is
# that nothing happens.
#
# So the rule is inverted: gate EVERYTHING, exempt a short list. The two
# directions fail differently, and that asymmetry is the entire argument:
#
#   allowlist  — a new prefix appears and is silently ungated. Nobody learns.
#   exemption  — a new prefix appears and is gated. Somebody sees it on their
#                first push and either writes `ac_verified:` (correct) or adds
#                an exemption here on purpose, in a diff, under review.
#
# Same principle scripts/devops/tests/run-guard-tests.sh states for itself:
# "the failure mode this whole suite exists to prevent is silence about
# something that is missing, not noise about something that is broken."
#
# ── THE EXEMPTIONS, AND WHAT EACH ONE COSTS ──────────────────────────────────
#
# Every exemption is a hole. Three, each with a reason and a stated cost:
#
#   main / master — trunk, not a work branch. Direct pushes there are refused
#     upstream anyway (branch protection; `pre:bash:safety` blocks force-push).
#     Cost: none that this gate could have caught.
#
#   architect/**  — carried over from this hook's original comment ("architect/
#     legal/etc. are out of scope"), not newly granted. An Architect deliverable
#     is an ADR whose acceptance is the review itself; there is no task-file AC
#     list to cite. Zone-of-write keeps Architect out of apps/** and packages/**
#     and no merged architect/ PR has ever carried a file from either.
#     COST, stated plainly: Architect MAY write .claude/hooks/**, .claude/rules/**
#     and .github/workflows/**, and on an architect/ branch does not have to say
#     what was verified. This very hook could be changed on such a branch
#     unannounced.
#
#   legal/**      — same clause, same origin, same reasoning; Legal's zone is
#     docs/legal/** and .claude/knowledge/legal/**.
#     COST: identical in shape to architect/**, smaller in reach.
#
# Deliberately NOT exempt, against the temptation: docs/, chore/, assets/,
# claude/, perf/, ci/, refactor/, revert/, and bare-named branches. `docs/`
# is the one that looks safest and is measurably the worst — see #613 above.
# A push on any of them that genuinely has nothing to verify has two honest
# one-line answers already supported below: a `wip:` subject, or
# `ac_verified: n/a (<why>)`. Neither is a bypass; both are a statement.
#
# Contract:
#   - Reads tool-call JSON from stdin.
#   - Fast-exit (0) on every non-`git push` command — main perf win vs legacy.
#   - exit 2 + JSON decision body on block.
#
# Decision tree (after `git push` is detected):
#   - Not in a git work tree                  → allow (exit 0)
#   - Detached HEAD (no branch name)          → allow (nothing to classify)
#   - Branch main/master/architect/*/legal/*  → allow (exempt, see above)
#   - Last commit is `wip:` / `wip(scope):`   → allow (milestone chunking)
#   - Last commit has an `ac_verified:` line  → allow
#   - Last commit is merge (>1 parent)        → allow
#   - Otherwise                                → BLOCK
#
# Test: scripts/devops/tests/test-pre-bash-coder-push-gate.sh (by execution
# against fake repos). It did not exist until 2026-09-01, and the meta-guard
# scripts/devops/check-guard-tests-exist.sh could not have noticed: it only
# ever looked at scripts/devops/check-*, so no hook in this directory was in
# its field of view. That is fixed in the same change as this one.

set -u

CMD=$(python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null || true)

# Fast exit: not a `git push` invocation at all.
[ -z "$CMD" ] && exit 0
if ! echo "$CMD" | grep -qE '(^|[[:space:]])git[[:space:]]+push([[:space:]]|$)'; then
  exit 0
fi

# Skip `git push --help` / `-h`.
if echo "$CMD" | grep -qE '(^|[[:space:]])(-h|--help)([[:space:]]|$)'; then
  exit 0
fi

# Must be inside a git work tree to enforce.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

BRANCH=$(git branch --show-current 2>/dev/null || echo "")
# Detached HEAD: `--show-current` prints nothing. There is no branch to
# classify, and a detached push is not the agent workflow this gate is about.
[ -z "$BRANCH" ] && exit 0

# Exempt branches — the ONLY way past the gate without saying anything.
# Read the header before adding to this line; each entry is a hole with a
# named cost.
if echo "$BRANCH" | grep -qE '^(main|master)$|^(architect|legal)/'; then
  exit 0
fi

LAST_MSG=$(git log -1 --pretty=%B 2>/dev/null || echo "")

# WIP milestone push — allowed by Coder task-chunking contract (coder.md §7).
if echo "$LAST_MSG" | grep -qE '^wip(\([^)]*\))?:'; then
  exit 0
fi

# Verified — allow.
if echo "$LAST_MSG" | grep -qE '^ac_verified:'; then
  exit 0
fi

# Merge commit — allow.
PARENTS=$(git log -1 --pretty=%P 2>/dev/null | wc -w | tr -d ' ')
if [ "${PARENTS:-0}" -gt 1 ] 2>/dev/null; then
  exit 0
fi

# Block.
python3 -c "
import json
reason = '''🚫 PRE-PUSH BLOCK: последний commit на ветке '$BRANCH' не содержит 'ac_verified:' строки.

Перед push добавь в commit message:
    ac_verified: 1,2,3        # номера AC из task-файла
    vision: ✓ /crm/<route>    # только для UI задач

Если AC выполнены не все — укажи сделанные + комментарий:
    ac_verified: 1,2 (3 — blocked, см. .blocked.md)

Если это intermediate milestone push в больших задачах — используй wip-префикс:
    git commit -m \"wip(<scope>): <milestone>\"

Если у ветки вообще нет AC (скриншоты, заметки, черновик) — скажи это явно:
    ac_verified: n/a (<почему>)

Гейт закрывает ВСЕ ветки, кроме main/master, architect/*, legal/*
(см. шапку .claude/hooks/pre-bash-coder-push-gate.sh — там же цена каждого
исключения). См. .claude/agents/coder.md §2.9 (Verification) и §7 (Task chunking).'''
print(json.dumps({'decision': 'block', 'reason': reason}))
" 2>/dev/null

echo "[pre:bash:coder-push-gate] BLOCK branch=$BRANCH (no ac_verified)" >&2
exit 2
