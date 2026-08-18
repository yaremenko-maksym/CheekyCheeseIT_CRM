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
#     echo "никогда: git push --force origin main" -> BLOCK
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
# (segments split on ;/&&/||/|/&/newline, `sh -c` and `$( )` recursed into,
# `VAR=v`/`env`/`sudo`/`nohup`/`timeout`/`xargs` unwrapped, heredoc bodies
# treated as data). Danger behind any of those forms is still caught; see
# scripts/devops/tests/test-pre-bash-safety.sh, which runs both directions.
# ---------------------------------------------------------------------------
#
# Contract:
#   - Reads tool-call JSON from stdin (Claude Code PreToolUse contract).
#   - exit 0 with no output  → allow.
#   - exit 2 with stderr     → block (ECC convention) AND emit JSON
#                              {"decision":"block","reason":"..."} to stdout for
#                              legacy compatibility with Claude Code's JSON
#                              control-flow path.
#   - exit 1 + `INTERNAL ERROR` on stderr → the analyzer itself failed. This is
#     NOT a verdict. It matters because a hook that dies on a syntax error also
#     exits non-zero (bash exits 2 — indistinguishable from a block by exit code
#     alone), so the contract is: a real verdict ALWAYS carries the decision JSON
#     on stdout, and an analyzer failure ALWAYS says INTERNAL ERROR on stderr.
#     If the analyzer dies while the old coarse test still sees something
#     catastrophic, the fallback blocks anyway — labelled ДЕГРАДИРОВАННЫЙ РЕЖИМ.
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
#
# Deliberate, stated gaps (same line the sibling pre-bash-cross-agent-blast.sh
# draws, and for the same reason — closing them means either evaluating the
# shell or going back to matching the raw line, which is the disease):
#   - indirection through a variable: `SQL="DROP DATABASE crm_db"; psql "$SQL"`,
#     `D=/etc; rm -rf "$D"`;
#   - a dangerous command inside a script file this hook cannot read;
#   - `eval "$CMD"`.
# Every real incident used a direct form, and every direct form is caught.
#
# Performance note: one python3 start per Bash call — the same cost as the
# previous version, which already needed python3 just to read the JSON.

set -u

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT=$(cat)

[ -z "$INPUT" ] && exit 0

printf '%s' "$INPUT" | CMDSCAN_LIB="$SELF_DIR/lib" python3 -c '
import json, os, re, sys

sys.path.insert(0, os.environ["CMDSCAN_LIB"])
import cmdscan

data = json.load(sys.stdin)
cmd = (data.get("tool_input") or {}).get("command") or ""
if not cmd:
    sys.exit(0)

scan = cmdscan.scan(cmd)
blocked = []

# ── predicate 1+2: rm -rf on root / home paths ───────────────────────────────
SAFE_ROOTS = ("/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/")
HOME_SAFE = ("~/Downloads", "$HOME/Downloads", "${HOME}/Downloads")


def dangerous_rm_target(tok):
    t = tok.rstrip("/") or "/"
    if t in ("/", "/*", "/.", "~", "$HOME", "${HOME}"):
        return True
    for safe in HOME_SAFE:
        if t == safe or t.startswith(safe + "/"):
            return False
    if t.startswith("~/") or t.startswith("$HOME/") or t.startswith("${HOME}/"):
        return True
    if not t.startswith("/"):
        return False
    for root in SAFE_ROOTS:
        if (t + "/").startswith(root):
            return False
    return True


for seg in scan.segments:
    if seg.name not in ("rm", "rmdir"):
        continue
    flags = [t for t in seg.argv if t.startswith("-") and t != "-"]
    recursive = any(
        ("r" in f[1:] and not f.startswith("--")) or f in ("--recursive",)
        for f in flags
    )
    if seg.name == "rm" and not recursive:
        continue
    for tok in seg.positionals():
        if dangerous_rm_target(tok):
            blocked.append("rm -rf on root/home path (%s)" % tok)
            break
    if blocked:
        break

# ── predicate 3: classic bash fork bomb ──────────────────────────────────────
# Matched on the UNQUOTED text: a fork bomb inside quotes is a string.
FORK_BOMB = re.compile(r":\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:")
if FORK_BOMB.search(scan.code_view):
    blocked.append("fork bomb")

# ── predicate 4: force push to main/master ───────────────────────────────────
FORCE_FLAGS = ("--force", "-f", "--force-with-lease")


def targets_protected_ref(tokens):
    for tok in tokens:
        ref = tok.lstrip("+")
        ref = ref.split(":")[-1]
        ref = ref.rsplit("/", 1)[-1]
        if ref in ("main", "master"):
            return True
    return False


for seg in scan.segments:
    if seg.name != "git":
        continue
    pos = seg.positionals()
    if not pos or pos[0] != "push":
        continue
    forced = any(
        f in FORCE_FLAGS or (f.startswith("-") and not f.startswith("--") and "f" in f[1:])
        for f in seg.argv if f.startswith("-")
    )
    forced = forced or any(t.startswith("+") for t in pos[1:])
    if forced and targets_protected_ref(pos[1:]):
        blocked.append("force push to main/master")
        break

# ── predicate 5: dropping the live database ─────────────────────────────────
# The phrase reaching a command that could execute it is the danger; the same
# phrase reaching `echo`, `gh pr create --body`, `git commit -m` or a heredoc
# that writes a file is a quotation. Unknown commands count as dangerous — the
# allowlist says what is inert, it does not enumerate what is dangerous.
DROP_RE = re.compile(r"DROP\s+DATABASE\s+(IF\s+EXISTS\s+)?[\"\x27`]?crm_db", re.I)
INERT = {
    "", "echo", "printf", "cat", "tee", "gh", "git", "jq", "yq", "head", "tail",
    "grep", "egrep", "fgrep", "rg", "ag", "sed", "awk", "less", "more", "wc",
    "sort", "uniq", "cut", "tr", "diff", "comm", "column", "pbcopy", "true",
    ":", "test", "cp", "mv", "touch", "open", "bat", "code", "prettier", "date",
}
for seg in scan.segments:
    if DROP_RE.search(seg.text()) and os.path.basename(seg.name) not in INERT:
        blocked.append("DROP DATABASE crm_db (исполняется через `%s`)" % (seg.name or "?"))
        break
    if seg.name == "dropdb" and "crm_db" in seg.positionals():
        blocked.append("dropdb crm_db")
        break

if not blocked:
    sys.exit(0)

reason = blocked[0]
msg = (
    "Заблокировано safety хуком: %s. Выполни вручную если уверен.\n\n"
    "Хук смотрит на КОМАНДУ, а не на подстроку: процитировать опасную фразу "
    "(echo, git commit -m, gh pr create --body, heredoc в файл) можно свободно — "
    "заблокировано именно исполнение." % reason
)
print(json.dumps({"decision": "block", "reason": msg}))
sys.stderr.write("[pre:bash:safety] BLOCK: %s\n" % reason)
sys.exit(10)
'
RC=$?

case "$RC" in
  0) exit 0 ;;
  10) exit 2 ;;
esac

# ── analyzer failure — NOT a verdict ──────────────────────────────────────────
echo "[pre:bash:safety] INTERNAL ERROR: анализатор не отработал (rc=$RC) — это НЕ вердикт хука." >&2

# JSON punctuation flattened to spaces: the raw stdin is JSON, so a command's
# last token is followed by `"` and the patterns' `([[:space:]]|$)` boundaries
# would never match — a fallback that quietly matches nothing is worse than no
# fallback, because it looks like protection.
FLAT=$(printf '%s' "$INPUT" | tr '"{},' '    ')
if echo "$FLAT" | grep -qE 'rm[[:space:]]+-rf?[[:space:]]+(/[a-zA-Z]|/[[:space:]]|~/?|\$HOME)' ||
  echo "$FLAT" | grep -qE ':[[:space:]]*\([[:space:]]*\)[[:space:]]*\{[[:space:]]*:[[:space:]]*\|[[:space:]]*:[[:space:]]*&[[:space:]]*\}[[:space:]]*;[[:space:]]*:' ||
  echo "$FLAT" | grep -qE 'git[[:space:]]+push.*(--force|--force-with-lease|[[:space:]]-f([[:space:]]|$)).*((origin[[:space:]]+)?(main|master))' ||
  echo "$FLAT" | grep -qiE 'DROP[[:space:]]+DATABASE[[:space:]]+crm_db'; then
  printf '%s\n' '{"decision":"block","reason":"⚠️ ДЕГРАДИРОВАННЫЙ РЕЖИМ safety-хука: анализатор команды не отработал (см. INTERNAL ERROR в stderr), поэтому применено старое грубое правило «слово-подстрока». Это может быть ЛОЖНОЕ срабатывание (оно ловит и обычное цитирование). Чини .claude/hooks/lib/cmdscan.py, а не обходи хук."}'
  echo "[pre:bash:safety] BLOCK (degraded fallback, coarse substring rule)" >&2
  exit 2
fi
exit 1
