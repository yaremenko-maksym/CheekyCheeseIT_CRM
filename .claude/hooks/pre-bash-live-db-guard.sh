#!/bin/bash
# ECC stable id: pre:bash:live-db-guard
#
# Purpose: make it EARLY and CHEAP to notice an agent worktree/scratchpad
# process about to reach the OWNER'S live dev database or collide with the
# owner's live dev ports - an advisory layer, NOT a guarantee (see STATUS:
# ADVISORY below; the authoritative check is backlog entry 247).
# 2026-08-05 incident (PR #485): an agent's dev-API
# process inherited API_PORT=3000 and DATABASE_URL=.../crm_db from the
# parent session's environment — its OWN .env in the worktree was silently
# ignored, because dotenv (and NestJS ConfigModule) never overwrite a
# process.env var that is already set. The API listened on :3000 against
# the live crm_db for ~2 minutes. No data was touched, only by luck; a
# migration or a write endpoint hit a minute later could have corrupted
# real financial records. The dispatch-prompt warning "set DATABASE_URL /
# API_PORT explicitly" is repeated in every agent prompt already and did
# NOT prevent this — so the fix has to be mechanical, not another warning.
#
# Root cause, precisely: inline env-var prefixes (VAR=value cmd) and
# `export VAR=value` DO override inherited env — but a bare .env file
# loaded by dotenv does NOT, if the shell already exported the var. The
# only reliably-safe pattern is an EXPLICIT inline override on the command
# itself. Absence of an explicit override is therefore treated as unsafe,
# even though "nothing was written" looks like the safe default — it is
# exactly the opposite (see class 3 below).
#
# ---------------------------------------------------------------------------
# STATUS: ADVISORY. THIS HOOK IS FAST AND EARLY, NOT COMPLETE.
# Four security rounds on this file (2026-10-19/20) ended with the same finding in
# new spellings: the hook computes, from TEXT, what bash will do. Inside a launch it
# recognises the model holds (about 330 probes, no env spelling / computed command word /
# unmodelled wrapper got a recognised launch past it); but "is this a launch" defaults
# to allow, and a hook reads text while bash resolves functions, aliases, PATH, startup
# files and an interpreter's flags. These are NOT closable by reading text, and are
# deliberately not chased: a shell function or alias named like the launcher, a PATH shim,
# NODE_OPTIONS=--require, BASH_ENV, and the full value-taking-flag taxonomy of an
# interpreter (review findings SR-H-16 and SR-H-17, SUPERSEDED, not fixed). The tripwire
# written in the python header below has fired.
# The authoritative check belongs where the connection is actually made: the API own
# boot reads the database it really connected to and refuses the live name, after every
# layer of shell, wrapper and flag has had its say (backlog entry 247, PR #1051). Until it
# exists this hook stays as the early, cheap layer - and it stays strict about HOW a
# launch is written, because that part is checkable. Do NOT start a further hardening
# round here: anything new goes to entry 247.
#
# ---------------------------------------------------------------------------
# The analyzer lives in lib/live_db_guard_analyzer.py (2026-11-11). Until then it sat
# inside a bash single-quoted string, where one apostrophe ended the string and bash
# died at parse time (exit 2, indistinguishable from an honest block; it happened twice),
# and where it grew to 32056 characters, within reach of the Windows command-line cap.
# A file has neither hazard. Before every commit, still:
#     bash -n .claude/hooks/pre-bash-live-db-guard.sh && <run the suite>
# chained with &&, not ;.
#
# ---------------------------------------------------------------------------
# HOW IT DECIDES WHAT IS BEING LAUNCHED (rewritten 2026-08-18, backlog 63)
#
# It used to grep the raw command line for `vite`, `nest start`, `pnpm dev`,
# `dist/main`. A word in ANY position was enough, so this hook refused
#
#     git show <ref>:pnpm-lock.yaml | grep -n vite      (pure read, no process)
#     ls -la node_modules/.bin/vite
#     node -e "console.log('apps/api/dist/main.js')"
#
# with a wall of text about booting a dev server against the live database.
# That is not a cosmetic annoyance: the workaround is printed inside the
# refusal itself, so two false hits are enough to train "prepend `DATABASE_URL=`
# and retry" — a reflex that then fires on a REAL launch too. The predicates
# are NOT relaxed; the question changed from "does the line contain X" to
# "is X the command being executed", which is the only difference between
# `grep vite` and `vite`.
#
# The parse lives in lib/cmdscan.py (shared with pre-bash-devserver-ttl-gate.sh,
# which must agree token-for-token on what a launch is — they used to carry the
# same regex twice, which is why narrowing one alone would still have left this
# `grep` refused). It splits on `;`/`&&`/`||`/`|`/`&`/newline and on shell
# grouping, recurses into `sh -c`, `eval`, `find -exec` and `$( )`, unwraps
# `VAR=v` and the wrapper commands, and decides on the COMMAND WORD.
#
# WHAT THE FIRST VERSION GOT WRONG (security review, 2026-08-18). It trusted the
# parse unless `shlex` had thrown. The review produced 13 reproduced misses —
# `env -i pnpm dev`, `sudo -s pnpm dev`, `{ pnpm dev ; }`, `script -q /dev/null
# pnpm dev` — in every one of which the parser had NOT failed; it had answered
# confidently and wrong. So the trust boundary moved: cmdscan marks a segment
# `confident` only when it resolved the command word AND understands the command,
# and an unconfident segment is judged by every "the command might start here"
# reading of itself. `$RUNNER dev` and an unknown wrapper are now the same case,
# and neither can turn a would-be block into an allow.
#
# The third round then fixed the OTHER half of that sentence — "AND understands
# the command". The understood list contained commands that run their argument
# (`tar`, `rsync`, `ssh`, `pnpm exec`, …), and being on it skips the re-reading
# entirely, so `bun x pnpm dev` reached this hook as "a bun command". Pruned in
# lib/cmdscan.py; `git` and `psql` stay and surrender their exec surface instead.
#
# The environment is read PER SEGMENT: an inline prefix reaches only the command
# it is glued to, `export` reaches later segments. `DATABASE_URL=…/crm_qa echo ok
# && pnpm dev` gives the launch nothing, and is refused.
# ---------------------------------------------------------------------------
#
# Contract:
#   - Reads tool-call JSON from stdin.
#   - Fast-exit 0 for non-dev-server commands.
#   - Fast-exit 0 outside agent worktree / claude scratchpad context — the
#     owner's own main-checkout session is legitimate and untouched.
#   - exit 2 + JSON decision body on block.
#   - exit 2 + `INTERNAL ERROR` on stderr when the ANALYZER itself fails: a
#     command nobody read is not a command that was cleared, and exit 1 would
#     not block. A broken hook must still never be mistaken for a verdict on the
#     merits, so the mark is on the output: stderr says INTERNAL ERROR, and the
#     only block body it can print is the coarse fallback, which runs when the
#     coarse test says a launcher is present and labels itself DEGRADED MODE,
#     so nobody debugs the wrong thing.
#   - CI runners never see this file at all (hooks are a local Claude Code
#     mechanism; GitHub Actions does not invoke .claude/hooks/**).
#
# What gets blocked, once command+context match (any ONE reason is enough):
#   1. DATABASE_URL explicitly set inline to a value whose db name is
#      exactly `crm_db` (the one shared live Postgres db — see
#      docker-compose.yml POSTGRES_DB). `crm_qa` / `crm_qa_*` (the
#      designated scratch db) and an explicit EMPTY value are both safe.
#   2. A port explicitly set inline (API_PORT=/PORT=/WEB_PORT=/--port) to
#      3000 or 3001 — the live pair (web/api, see apps/web/vite.config.ts
#      server.port and apps/api/src/main.ts API_PORT default).
#   3. Neither DATABASE_URL nor a port is set inline AT ALL — the covert
#      inheritance case, and the one that actually caused PR #485: no
#      override present reads as "will inherit whatever the parent shell
#      already exported", which this hook cannot verify and therefore
#      treats as unsafe by default.
#
# What stays possible (must NOT be blocked — see PR body for proof runs):
#   - Any command outside .claude/worktrees/** and claude scratchpads
#     (owner / master session on the live stack is legitimate work).
#   - Explicit safe values (non-crm_db db name + non-3000/3001 port).
#   - `DATABASE_URL=` (explicitly empty) — the established safe idiom for
#     feature-branch pushes (git-policy.md); this hook never even fires on
#     a `git push`, since it only matches dev-server launchers below.
#   - vitest / Playwright runs (not in the launcher pattern — see sibling
#     hook's header for why; unchanged here).
#   - READING about a launcher: grep/rg/ls/git show/echo naming `vite`,
#     `pnpm dev`, `dist/main` in any position.

set -u

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT=$(cat)

[ -z "$INPUT" ] && exit 0

# Hot path: if no launcher word occurs anywhere in the payload, nothing below
# can fire — leave before paying for a python start. Deliberately a SUPERSET of
# what the analyzer can block (never a second, divergent policy). Quotes and
# backslashes are dropped first (`d''ev` runs dev), and a `$`, backtick or backslash
# goes to the analyzer: the first two can build any word, and a backslash-newline
# joins one (`d\<newline>ev`, SR-M-1 of #1294) while the JSON escape leaves the n of
# `\n` behind (`dnev`).
# LC_ALL=C: under a UTF-8 locale macOS tr and grep fail on an invalid byte (#1297 SR-L-6).
printf '%s' "$INPUT" | LC_ALL=C tr -d "'\"\\\\" | LC_ALL=C grep -qE 'vite|nest|dev|dist/main|start|preview' \
  || printf '%s' "$INPUT" | LC_ALL=C grep -q '[$`\]' || exit 0

# The analyzer is a file (lib/live_db_guard_analyzer.py), not a `python3 -c` argument:
# Windows caps a whole command line at 32767 characters, and a -c body past that fails
# to launch (E2BIG, rc 126). scripts/devops/check-hook-inline-python-size.py keeps every
# inline -c body of the hooks under that limit.
printf '%s' "$INPUT" | PYTHONDONTWRITEBYTECODE=1 CMDSCAN_LIB="$SELF_DIR/lib" \
  python3 -I -B "$SELF_DIR/lib/live_db_guard_analyzer.py"
RC=$?

case "$RC" in
  0) exit 0 ;;
  10) exit 2 ;;
esac

# ── analyzer failure — NOT a verdict ──────────────────────────────────────────
# Everything below runs only when the analyzer could not finish (missing
# python3, missing lib/cmdscan.py, an edit that broke it). It says so loudly and
# falls back to the pre-2026-08-18 coarse test, so the protection does not
# silently disappear — but it never impersonates a decision on the merits.
echo "[pre:bash:live-db-guard] INTERNAL ERROR: the analyzer did not run (rc=$RC) — this is NOT a verdict of the hook." >&2

LEGACY='(^|[/[:space:]])nest(\.js)?[[:space:]]+start|(^|[/[:space:]])vite([[:space:]]|$)|(^|[[:space:]])(pnpm|npm|yarn|turbo)([[:space:]]+(-[^[:space:]]+|--filter[[:space:]]+[^[:space:]]+|run))*[[:space:]]+(dev|start|preview)(:[[:alnum:]_.-]+)?([[:space:]]|$)|node[[:space:]][^;|&]*dist/main'
# The raw stdin is JSON, so the command's last token is followed by `"` — the
# legacy pattern's `([[:space:]]|$)` boundary would silently never match and the
# fallback would let everything through. Turning JSON punctuation into spaces
# restores the token boundaries without needing a parser (python3 may be exactly
# what is missing here). Verified by the test case
# "BROKEN analyzer + a dangerous launch: blocks, but labelled DEGRADED"
# in scripts/devops/tests/test-pre-bash-live-db-guard.sh — quoted exactly, so a
# grep for this string finds it.
FLAT=$(printf '%s' "$INPUT" | tr '"{},' '    ')
if echo "$FLAT" | grep -qE "$LEGACY" && echo "$FLAT" | grep -qE '\.claude[/\\]+worktrees[/\\]|/tmp/claude-'; then
  printf '%s\n' '{"decision":"block","reason":"⚠️ DEGRADED MODE live-db-guard: the command analyzer did not run (see INTERNAL ERROR on stderr), so the old coarse word-substring rule was applied. This may be a FALSE POSITIVE. Fix .claude/hooks/lib/cmdscan.py instead of bypassing it: bash .claude/hooks/pre-bash-live-db-guard.sh < <(echo JSON) will show the reason."}'
  echo "[pre:bash:live-db-guard] BLOCK (degraded fallback, coarse substring rule)" >&2
  exit 2
fi
# Refused, because a command nobody read is not a command that was cleared.
echo "[pre:bash:live-db-guard] Refused: no analyzer, so this command was not read. Fix it first: python3 must run on PATH and the hook library must load. Bash stays refused until then." >&2
exit 2
