#!/usr/bin/env bash
# ECC stable id: post:edit-write:undurable-work
#
# Purpose: tell an agent that it is accumulating substantial work in a worktree
# that holds NO COMMIT OF ITS OWN — the one state in which the stream watchdog
# does not cost a re-read but costs the whole stretch.
#
# ── WHY A HOOK AND NOT A PARAGRAPH ──────────────────────────────────────────
#
# .claude/rules/common/stream-watchdog.md already says "commit and push as you
# go", it has no `paths:` frontmatter, and RULES.md §0 records what that means:
# such a file is injected into every request of every session AND EVERY
# SUBAGENT. On 2026-10-20 five agents were cut in one day on one feature, every
# one of them with that text in context, and two of them after the orchestrator
# had additionally retyped the advice verbatim into the resume message. The
# delivery channel was not the defect. Advice-as-the-only-mechanism was.
#
# Of those five, the expensive one wrote nothing at all: it thought for a long
# stretch and then composed a 231-line workflow file in a single tool call. The
# harness removes a worktree it judges unchanged, so the cut did not cost a
# re-read — the work was simply gone, and the same file was later rebuilt from
# scratch in seven `wip:` pushes (branch devops/host-key-pin-canary).
#
# ── WHY POST AND NOT PRE ────────────────────────────────────────────────────
#
# A PreToolUse refusal on a large write would throw away content the agent had
# already spent the silent stretch producing — it would charge for the very
# thing it exists to protect. PostToolUse lets the write land and feeds the
# demand back to the model (exit 2 → stderr reaches the agent), so the fix is
# `git commit && git push`, not a re-emission.
#
# ── THE PREDICATE, AND WHAT IT DELIBERATELY DOES NOT CLAIM ──────────────────
#
# It fires when all three hold:
#   1. the edit is inside an agent worktree — the orchestrator's own checkout
#      and the owner's editing are untouched;
#   2. the branch has NO commit of its own (nothing in origin/main..HEAD), i.e.
#      the worktree is in exactly the state the harness may remove;
#   3. uncommitted work has reached UNDURABLE_LINES added lines.
#
# It does NOT predict silence. Nothing available to a hook can: the clock runs
# on the stream, and a hook only runs when the stream has just spoken. What it
# measures instead is the BLAST RADIUS of a cut, which is decidable from git
# alone and is the whole difference between "costs a re-read" and "costs
# everything". Once one commit exists the hook goes quiet for the rest of the
# session — the cheap half of the cure is then in place, and the rule, not the
# hook, asks for the push.
#
# THRESHOLD, from the 2026-10-20 evidence rather than taste: the compose that
# was lost was 231 lines; the first durable commit of the rebuild was 42. 120
# sits between them, so this hook would have fired once on that agent, early,
# and stayed silent through the whole of the rebuild's cadence.
#
# FALSE-POSITIVE BUDGET: one feedback message per agent, at most — the first
# commit silences it permanently. It cannot fire in the main checkout, cannot
# fire on a branch that is already building commits, and undoes nothing when it
# does fire.
#
# Contract: PostToolUse, matcher "Edit|Write|MultiEdit|NotebookEdit".
#   stdin = tool-call JSON. exit 0 → silent. exit 2 + stderr → feedback to the
#   agent (the tool has already run; nothing is reverted).
# Test: scripts/devops/tests/test-post-edit-write-undurable-work.sh
#
# Env (tests only): UNDURABLE_LINES overrides the threshold.

set -u

UNDURABLE_LINES="${UNDURABLE_LINES:-120}"

# The workspace comes from the payload's `cwd` (the same field
# pre:bash:devserver-ttl-gate reads), falling back to $PWD. Taking it from the
# payload is what makes the predicate testable without standing a real agent up.
INPUT=$(cat)
CWD=$(printf '%s' "$INPUT" | python3 -c '
import json, sys
try:
    print((json.load(sys.stdin).get("cwd") or "").strip())
except Exception:
    print("")
' 2>/dev/null || true)
[ -z "$CWD" ] && CWD="$PWD"

# 1. Agent workspace only.
case "$CWD" in
*/.claude/worktrees/*) ;;
*) exit 0 ;;
esac

[ -d "$CWD" ] || exit 0
git() { command git -C "$CWD" "$@"; }

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

BRANCH=$(git branch --show-current 2>/dev/null || true)
[ -z "$BRANCH" ] && exit 0

# 2. A commit of its own already exists -> not in the removable state, and the
#    agent has demonstrably got the cadence. Stay quiet.
BASE=$(git rev-parse --verify --quiet origin/main 2>/dev/null ||
  git rev-parse --verify --quiet main 2>/dev/null || true)
[ -z "$BASE" ] && exit 0
OWN=$(git rev-list --count "$BASE..HEAD" 2>/dev/null || echo 0)
[ "${OWN:-0}" -gt 0 ] && exit 0

# 3. How much uncommitted work is riding on this workspace: tracked additions
#    plus every line of every untracked file.
TRACKED=$(git diff --numstat HEAD 2>/dev/null |
  awk '{ if ($1 ~ /^[0-9]+$/) s += $1 } END { print s + 0 }')
UNTRACKED=$(git ls-files --others --exclude-standard -z 2>/dev/null |
  (cd "$CWD" && xargs -0 wc -l 2>/dev/null) |
  awk '$2 != "total" { if ($1 ~ /^[0-9]+$/) s += $1 } END { print s + 0 }')
LINES=$((${TRACKED:-0} + ${UNTRACKED:-0}))

[ "$LINES" -lt "$UNDURABLE_LINES" ] && exit 0

cat >&2 <<EOF
⏳ UNDURABLE WORK: $LINES uncommitted lines, and this workspace holds no commit
of its own yet.

Make it durable now, before the next long step:

  git add <the files you changed>      # explicitly, by name
  git commit -m "wip: <what exists so far>"
  DATABASE_URL= git push -u origin $BRANCH

Why now and not later: the watchdog cuts an agent after 600 s with nothing on its
stream, and the clock runs on SILENCE — a long think, or composing a large file in
one call, is silence with no subprocess in it. A cut after a push costs the next
agent a re-read. A cut in this state costs the stretch outright: the harness
removes a workspace it judges unchanged, and one with no commit of its own is
exactly that. On 2026-10-20 five agents were cut in one day; the expensive one
lost a 231-line file it had composed in a single call.

Then keep producing in pieces that each end in a push — skeleton first, one
section per call. Rule: .claude/rules/common/stream-watchdog.md
EOF
exit 2
