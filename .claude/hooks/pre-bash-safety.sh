#!/bin/bash
# ECC stable id: pre:bash:safety
# Phase 2 ECC port of legacy .claude/hooks/safety.sh.
#
# Purpose: block truly catastrophic Bash commands — fork bombs, rm -rf on root
# paths, force push to main/master, dropping the live crm_db. Everything else
# fast-exits so the hook never gates non-target commands.
#
# ---------------------------------------------------------------------------
# QUOTING IS NOT EXECUTION (rewritten 2026-08-18, backlog 106)
#
# This hook used to grep the RAW command line, so a command that merely QUOTED
# a dangerous phrase was refused:
#
#     echo "... DROP DATABASE crm_db ..."          -> BLOCK
#     gh pr create --body "... DROP DATABASE ..."  -> BLOCK  (this actually
#         happened while writing the PR description for pre-bash-cross-agent-blast)
#     echo "never: git push --force origin main" -> BLOCK
#
# Reproduced four times on 2026-08-17/18 — the fourth time on the very probe
# command written to demonstrate the bug. The damage is not the lost minute: a
# refusal that is obviously wrong teaches the reader to route around the hook,
# and that habit does not distinguish the wrong refusals from the right ones.
#
# No predicate is relaxed. The question changed from "does the line contain the
# phrase" to "is the dangerous thing what the line EXECUTES". `echo "rm -rf /"`
# and `rm -rf /` differ in exactly one respect — which token is in command
# position — so command position is what is now examined, via lib/cmdscan.py
# (segments split on ;/&&/||/|/&/newline and on shell grouping, `sh -c`, `eval`,
# `find -exec` and `$( )` recursed into, `VAR=v` and the wrapper commands
# unwrapped, heredoc bodies treated as data). Danger behind any of those forms is
# still caught; see scripts/devops/tests/test-pre-bash-safety.sh, which runs both
# directions.
#
# AND WHEN THE PARSE CANNOT BE TRUSTED (security review, 2026-08-18). The first
# version of this rewrite trusted its own answer unless `shlex` had thrown. The
# review produced 13 reproduced misses — `sudo -s rm -rf /etc` read as command
# `etc`, `{ rm -rf /etc ; }` as command `{`, `if …; then rm …; fi` as `then` —
# with the parser reporting no failure at all. The measure of it: with a BROKEN
# analyzer `sudo -s rm -rf /etc` was blocked, and with a working one it was not.
# So an unresolved segment is no longer judged by its command word; it is judged
# by every "the command might start here" reading of itself, through these same
# predicates. Unknown wrappers fail toward blocking, which is the only direction
# a list-based approach could never guarantee.
#
# AND WHAT "UNDERSTOOD" HAD TO MEAN (third round of the same review). The
# conservative path above is reached only for segments cmdscan does NOT claim to
# understand — and that list still held `tar`, `rsync`, `ssh`, `nc`, `psql` and
# `git`, all of which run what they are handed. Eleven forms on THIS hook were
# allowed here and refused by main, `tar --use-compress-program 'rm -rf /etc'`
# among them, with the marker file to prove the payload really runs. The list is
# pruned to what it always claimed to be, and the two commands that had to stay
# (git and psql — an agent types them all day, and reading their prose through
# readings() would refuse `git commit -m "…pnpm dev…"`) now hand over what they
# execute the way `find -exec` always did. See lib/cmdscan.py, UNDERSTOOD.
# ---------------------------------------------------------------------------
#
# Contract:
#   - Reads tool-call JSON from stdin (Claude Code PreToolUse contract).
#   - exit 0 with no output  → allow.
#   - exit 2 with stderr     → block (ECC convention) AND emit JSON
#                              {"decision":"block","reason":"..."} to stdout for
#                              legacy compatibility with Claude Code's JSON
#                              control-flow path.
#   - exit 2 + `INTERNAL ERROR` on stderr, no decision body → the analyzer itself
#     failed. This is NOT a verdict, but the command is still refused, because
#     nobody read it. The exit code alone cannot tell this from a block (a hook
#     that dies on a syntax error exits 2 too), so the contract is: a real verdict
#     ALWAYS carries the decision JSON on stdout, and an analyzer failure ALWAYS
#     says INTERNAL ERROR on stderr. If the old coarse test still sees something
#     catastrophic, the fallback also prints a decision body labelled DEGRADED MODE
#     (still exit 2, still INTERNAL ERROR on stderr).
#
# Specific predicates implemented (each decided on the executed command):
#   1. `rm -r[f]` whose target is a root-level path (`/`, `/*`, `/etc`, ...),
#      excluding the scratch roots /tmp/**, /private/tmp/**, /var/folders/**,
#      /private/var/folders/**.
#   2. `rm -r[f]` on `~`, `~/...`, `$HOME`, `${HOME}/...` — home blast radius.
#      `~/Downloads/...` stays allowed (kept from the legacy regex).
#   3. Fork bomb pattern `:(){:|:&};:` (any whitespace variant), matched against
#      the UNQUOTED text only, so `echo ':(){ :|:& };:'` is not a fork bomb.
#   4. Force push to main/master: `git push --force|-f|--force-with-lease` (or a
#      `+refs/...` refspec) aimed at a ref whose name is main/master.
#   5. Dropping the live database: `DROP DATABASE [IF EXISTS] crm_db` reaching a
#      command that is not a plain text consumer, and `dropdb crm_db`.
#   6. Writing that same SQL to a file and executing the file in the same line
#      (`echo "…" > /tmp/x.sql && psql -f /tmp/x.sql`). Each segment alone looks
#      innocent; the chain does not, and the whole chain is right there.
#
# Deliberate, stated gaps (same line the sibling pre-bash-cross-agent-blast.sh
# draws, and for the same reason — closing them means either evaluating the
# shell or going back to matching the raw line, which is the disease):
#   - indirection through a variable: `SQL="DROP DATABASE crm_db"; psql "$SQL"`,
#     `D=/etc; rm -rf "$D"`;
#   - a dangerous command inside a script file this hook cannot read.
# `eval "<literal>"` is NOT a gap — its argument is parsed as code. Neither is an
# interpreter s inline program (`python3 -c`, `awk BEGIN{system(…)}`): it cannot
# be parsed as that language, so it is re-read the coarse way instead of trusted.
# Every real incident used a direct form, and every direct form is caught.
#
# Performance note: one python3 start per Bash call — the same cost as the
# previous version, which already needed python3 just to read the JSON.

set -u

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT=$(cat)

[ -z "$INPUT" ] && exit 0

printf '%s' "$INPUT" | PYTHONDONTWRITEBYTECODE=1 CMDSCAN_LIB="$SELF_DIR/lib" python3 "$SELF_DIR/lib/pre_bash_safety.py"
RC=$?

case "$RC" in
  0) exit 0 ;;
  10) exit 2 ;;
esac

# ── analyzer failure — NOT a verdict ──────────────────────────────────────────
echo "[pre:bash:safety] INTERNAL ERROR: the analyzer did not run (rc=$RC) — this is NOT a verdict of the hook." >&2

# JSON punctuation flattened to spaces: the raw stdin is JSON, so a command's
# last token is followed by `"` and the patterns' `([[:space:]]|$)` boundaries
# would never match — a fallback that quietly matches nothing is worse than no
# fallback, because it looks like protection.
FLAT=$(printf '%s' "$INPUT" | tr '"{},' '    ')
if echo "$FLAT" | grep -qE 'rm[[:space:]]+-rf?[[:space:]]+(/[a-zA-Z]|/[[:space:]]|~/?|\$HOME)' ||
  echo "$FLAT" | grep -qE ':[[:space:]]*\([[:space:]]*\)[[:space:]]*\{[[:space:]]*:[[:space:]]*\|[[:space:]]*:[[:space:]]*&[[:space:]]*\}[[:space:]]*;[[:space:]]*:' ||
  echo "$FLAT" | grep -qE 'git[[:space:]]+push.*(--force|--force-with-lease|[[:space:]]-f([[:space:]]|$)).*((origin[[:space:]]+)?(main|master))' ||
  echo "$FLAT" | grep -qiE 'DROP[[:space:]]+DATABASE[[:space:]]+crm_db'; then
  printf '%s\n' '{"decision":"block","reason":"⚠️ DEGRADED MODE of the safety hook: the command analyzer did not run (see INTERNAL ERROR on stderr), so the old coarse word-substring rule was applied. This may be a FALSE POSITIVE (it fires on ordinary quoting too). Fix .claude/hooks/lib/cmdscan.py instead of bypassing the hook."}'
  echo "[pre:bash:safety] BLOCK (degraded fallback, coarse substring rule)" >&2
  exit 2
fi
# Refused, because a command nobody read is not a command that was cleared.
echo "[pre:bash:safety] Refused: no analyzer, so this command was not read. Fix it first: python3 must run on PATH and the hook library must load. Bash stays refused until then." >&2
exit 2
