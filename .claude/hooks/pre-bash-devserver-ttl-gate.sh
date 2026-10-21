#!/bin/bash
# ECC stable id: pre:bash:devserver-ttl-gate
#
# Purpose: prevent zombie dev-server accumulation. 2026-07-24 incident: 67
# orphaned nest/vite processes from agent worktrees (booted 2026-07-12..15,
# never stopped) drove the host into swap thrash (load average 70). The
# procedural "sweep zombie ports" rule failed — sessions die uncleanly, so
# the cleanup invariant moves into mechanics: any dev-server boot inside an
# agent worktree or claude scratchpad MUST go through
# scripts/devops/dev-ttl.sh (self-expiring process group).
#
# ---------------------------------------------------------------------------
# HOW IT DECIDES WHAT IS BEING LAUNCHED (rewritten 2026-08-18, backlog 63)
#
# This hook carried the SAME launcher regex as pre-bash-live-db-guard.sh,
# copy-pasted, matching a word in any position. So it refused
#
#     git show <ref>:pnpm-lock.yaml | grep -n vite
#
# — reproduced again on 2026-08-18 while fixing the sibling: narrowing only
# live-db-guard left this hook still blocking the very same honest read. That
# is why the definition of "a launch" now lives in ONE place, lib/cmdscan.py,
# and both hooks ask it the same question: is the launcher the COMMAND WORD of
# some segment, rather than a substring of the line. Nothing is relaxed —
# `pnpm dev` behind `&&`, `sh -c`, `env VAR=v`, `nohup`, `timeout`, an absolute
# path, or a command substitution is still caught (see the guard tests).
#
# And after the security review of that change: a command word the analyzer
# cannot resolve is no longer taken at face value either. `{ pnpm dev ; }`,
# `! pnpm dev`, `script -q /dev/null pnpm dev` and `find . -exec pnpm dev \;`
# all reported a confident, wrong command word and slipped through; now an
# unconfident segment is judged by every reading of itself, so a wrapper this
# hook has never heard of cannot smuggle a boot past it.
#
# Third round: that re-reading is skipped for any command cmdscan claims to
# understand, and the list claimed too much — `bun x pnpm dev` counted as "a bun
# command" and booted unwrapped. The list now holds only commands that execute
# nothing, or whose exec surface cmdscan hands over (lib/cmdscan.py, UNDERSTOOD).
#
# FOURTH ROUND (2026-10-21) — THE CLAIM BELOW WAS FALSE, AND THAT WAS THE DEFECT.
# This header used to end by stating that reading ABOUT a launch no longer trips
# the gate, because it looks only at launcher position. It refused four commands
# in one day, none of which launched anything:
#
#   pnpm why vite                      a dependency query. `pnpm` is not in
#                                      UNDERSTOOD, so the segment was UNCERTAIN,
#                                      so readings() re-read it from every
#                                      position and one reading was `vite`. The
#                                      subcommand table was never consulted.
#   cat > note.md <<'EOF' … EOF        a markdown note whose PROSE spelled
#                                      `pnpm dev` in backticks: 3 "launches".
#   gh pr create --body "$(cat <<'EOF' the PR description text: 1 "launch".
#   python3 - <<'PYEOF' … PYEOF        python STRING LITERALS: 2 "launches".
#
# The three heredocs share one cause: substitution extraction ran BEFORE heredoc
# capture, so bodies that stage 2 is emphatic are data had already been mined for
# `$(…)` and backticks — in bodies with a QUOTED delimiter, where bash itself
# performs no expansion at all. A guard that documents a property it does not
# have is worse than one that documents nothing, so the claim is now narrower and
# true, and each clause of it has a test:
#
#   * launcher position means the command word of a segment, AND
#   * a package runner's arguments are read only when the subcommand is outside
#     the vetted read-only set (PKG_QUERY_SPEC), AND
#   * a heredoc body with a quoted delimiter is never read as code — but only
#     while the segmenter agrees it IS that body; where the two readings of the
#     line disagree, the text is inspected rather than exempted.
#
# Nothing was relaxed to achieve it. An unquoted `<<EOF` body is still code (the
# shell really does expand it), `pnpm exec` / `dlx` / `x` and every non-query
# subcommand are still re-read, and the PR #485 shape — a launcher with no inline
# DATABASE_URL and no inline port — is still refused.
# ---------------------------------------------------------------------------
#
# Contract (mirrors pre-bash-coder-push-gate.sh):
#   - Reads tool-call JSON from stdin.
#   - Fast-exit 0 for non-dev-server commands.
#   - exit 2 + JSON decision body on block.
#   - exit 1 + `INTERNAL ERROR` on stderr when the analyzer itself fails — a
#     broken hook must not be mistaken for a hook that refused (a bash syntax
#     error exits 2 exactly like a verdict does; the distinguishing mark is
#     that a real verdict always carries a {"decision":"block"} body).
#
# Decision tree:
#   - the launching segment is itself wrapped in dev-ttl.sh → allow
#   - no segment actually launches a dev server        → allow (vitest/E2E
#     runs intentionally NOT matched — they self-terminate; and so is any
#     command that merely NAMES a launcher: grep/ls/git show/echo)
#   - neither cwd nor command references a worktree/
#     scratchpad path                                 → allow (main-repo
#     standing UT stack on :3000/:3001 is legit)
#   - otherwise                                       → BLOCK

set -u

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT=$(cat)

[ -z "$INPUT" ] && exit 0

# Hot path: a superset of everything the analyzer can block, so a command with
# none of these words never pays for a python start.
echo "$INPUT" | grep -qE 'vite|nest|dev|dist/main|start|preview' || exit 0

printf '%s' "$INPUT" | PYTHONDONTWRITEBYTECODE=1 CMDSCAN_LIB="$SELF_DIR/lib" python3 -c '
import importlib.util, json, os, re, sys

# By absolute path, not via sys.path — see the note in pre-bash-safety.sh.
_spec = importlib.util.spec_from_file_location(
    "cmdscan", os.path.join(os.environ["CMDSCAN_LIB"], "cmdscan.py"))
cmdscan = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cmdscan)

data = json.load(sys.stdin)
cmd = (data.get("tool_input") or {}).get("command") or ""
cwd = data.get("cwd") or ""
if not cmd:
    sys.exit(0)

# Enforce only in agent worktree / claude scratchpad context.
CONTEXT = re.compile(r"\.claude/worktrees/|/tmp/claude-")
if not CONTEXT.search(cmd) and not CONTEXT.search(cwd):
    sys.exit(0)

scan = cmdscan.scan(cmd)
# Confidence-aware (see the sibling hook): a segment whose command word could
# not be resolved contributes every reading of itself, so an unknown wrapper
# cannot smuggle a boot past the gate. The old `scan.degraded` special case is
# gone with it.
hits = cmdscan.launches(scan)

# Code the analyzer never reached (nesting past MAX_DEPTH) is refused rather
# than reported clean — with no wrappers, so the TTL check below fails it.
if not hits and scan.truncated:
    hits = [(
        cmdscan.Segment("", [], [], [], False, cmd, 0, {}, False, None),
        "nesting deeper than the parse limit — the code was not read",
    )]

# A decoy mention of dev-ttl.sh in one segment must not whitelist an unwrapped
# boot in another: the wrapper has to sit on the LAUNCHING segment itself.
unwrapped = [
    (seg, label) for seg, label in hits
    if "dev-ttl.sh" not in seg.wrappers
]
if not unwrapped:
    sys.exit(0)

label = unwrapped[0][1]
reason = """🚫 DEVSERVER-TTL BLOCK: a dev server is starting in an agent worktree/scratchpad without the TTL wrapper.

The launch that was recognised: %s

Why: the 2026-07-24 incident — 67 zombie nest/vite processes from agent worktrees
drove the Mac into swap thrashing (load average 70). A dev server under
.claude/worktrees/** MUST expire by itself on a TTL rather than rely on session
cleanup, because sessions die uncleanly.

The right way (the wrapper gives the process group a TTL, 4h by default):
    scripts/devops/dev-ttl.sh -- <your command>
    scripts/devops/dev-ttl.sh --ttl 7200 -- pnpm --filter @crm/api dev

Before booting, check the port is not still held by your own earlier server:
    lsof -ti tcp:<PORT> | xargs kill -9

NOT A LAUNCH (the hook lets these through):
  • the word as an argument — grep/ls/git show;
  • a read-only subcommand of pnpm and npm ONLY — `pnpm why vite`, `npm ls`,
    `pnpm outdated`; the list and the criterion are PKG_QUERY_SPEC in lib/cmdscan.py;
  • a heredoc body with a QUOTED delimiter (`<<'EOF'`, `<<\\EOF`) — a markdown
    note, a PR body, python string literals.
If one of these was refused, that is a bug in the hook, not a reason to add the wrapper.

REFUSED BY DESIGN, though not a launch either (not a bug; the wrapper will not help):
  • the same subcommands on turbo, yarn and bun — `yarn why`, `turbo ls dev`. For
    turbo the operand IS a task name (`turbo why dev` runs BOTH tasks, measured on
    turbo 2.11.7) and yarn falls through to `yarn run <script>`, so the grant is
    withheld from them deliberately: see PKG_QUERY_RUNNERS;
  • `pnpm version` / `npm audit fix` — they run lifecycle scripts and write the
    manifest, so the grant is not for them;
  • `--depth 2` BEFORE the subcommand (`pnpm --depth 2 ls`) — the grammar of that
    flag is position-dependent, and the reading that fails closed was chosen;
  • a command outside the understood list carrying a launcher-looking word as its
    own token inside quotes — `for c in "pnpm dev"; do …`, `cases=("pnpm dev")`.
    That is a deliberate trade: this same reading of quotes is what catches
    `script -q /dev/null pnpm dev`; see CONFIDENCE in lib/cmdscan.py.
The way around is the same in each case: do not leave the word as its own token
inside quotes, or move the text into a file with a quoted heredoc.

See .claude/rules/common/light-track.md ("Parallel dispatch") and scripts/devops/dev-ttl.sh.""" % label

print(json.dumps({"decision": "block", "reason": reason}))
sys.stderr.write(
    "[pre:bash:devserver-ttl-gate] BLOCK unwrapped dev-server boot in worktree/scratchpad (%s)\n" % label
)
sys.exit(10)
'
RC=$?

case "$RC" in
  0) exit 0 ;;
  10) exit 2 ;;
esac

# ── analyzer failure — NOT a verdict ──────────────────────────────────────────
echo "[pre:bash:devserver-ttl-gate] INTERNAL ERROR: the analyzer did not run (rc=$RC) — this is NOT a verdict of the hook." >&2

LEGACY='(^|[/[:space:]])nest(\.js)?[[:space:]]+start|(^|[/[:space:]])vite([[:space:]]|$)|(^|[[:space:]])(pnpm|npm|yarn|turbo)([[:space:]]+(-[^[:space:]]+|--filter[[:space:]]+[^[:space:]]+|run))*[[:space:]]+(dev|start|preview)(:[[:alnum:]_.-]+)?([[:space:]]|$)|node[[:space:]][^;|&]*dist/main'
# JSON punctuation flattened to spaces so the legacy pattern's `([[:space:]]|$)`
# boundaries still hold on the raw stdin (see the sibling hook for the full note).
FLAT=$(printf '%s' "$INPUT" | tr '"{},' '    ')
if echo "$FLAT" | grep -qE "$LEGACY" &&
  echo "$FLAT" | grep -qE '\.claude/worktrees/|/tmp/claude-' &&
  ! echo "$FLAT" | grep -q 'dev-ttl\.sh'; then
  printf '%s\n' '{"decision":"block","reason":"⚠️ DEGRADED MODE devserver-ttl-gate: the command analyzer did not run (see INTERNAL ERROR on stderr), so the old coarse word-substring rule was applied. This may be a FALSE POSITIVE. Fix .claude/hooks/lib/cmdscan.py instead of bypassing the hook."}'
  echo "[pre:bash:devserver-ttl-gate] BLOCK (degraded fallback, coarse substring rule)" >&2
  exit 2
fi
exit 1
