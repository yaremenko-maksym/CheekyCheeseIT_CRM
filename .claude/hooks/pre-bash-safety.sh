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

printf '%s' "$INPUT" | PYTHONDONTWRITEBYTECODE=1 CMDSCAN_LIB="$SELF_DIR/lib" python3 -c '
import importlib.util, json, os, re, shlex, sys

# Loaded by absolute path instead of sys.path.insert: putting lib/ on the import
# path made every stdlib module cmdscan imports (shlex) resolvable from that
# directory, on EVERY Bash call. The bar to abuse it was high, but the directory
# had no business being importable at all (review LOW).
_spec = importlib.util.spec_from_file_location(
    "cmdscan", os.path.join(os.environ["CMDSCAN_LIB"], "cmdscan.py"))
cmdscan = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cmdscan)

data = json.load(sys.stdin)
cmd = (data.get("tool_input") or {}).get("command") or ""
if not cmd:
    sys.exit(0)

scan = cmdscan.scan(cmd)
blocked = []

# Every predicate below judges CANDIDATES, not segments. For a segment the
# analyzer understood, the candidate list is just the segment. For one it could
# not (`script -q /dev/null rm -rf /etc`, `sudo -T 5 rm -rf /etc`, an unknown
# wrapper) it is every "the real command might start here" reading — so a
# wrapper nobody has added to the list still cannot hide the command it runs.
# This is the fix for the review finding that 13 misses all had degraded=False:
# the parser had not failed, it had been confidently wrong, and nothing checked.
def candidates(seg):
    return cmdscan.candidates(seg)

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
    for cand in candidates(seg):
        if cand.name not in ("rm", "rmdir"):
            continue
        flags = [t for t in cand.argv if t.startswith("-") and t != "-"]
        # `-R` is the same as `-r` for rm on both BSD and GNU; the first version
        # compared case-sensitively, so `rm -Rf /etc` read as non-recursive.
        recursive = any(
            ("r" in f[1:].lower() and not f.startswith("--")) or f in ("--recursive",)
            for f in flags
        )
        if cand.name == "rm" and not recursive:
            continue
        for tok in cand.positionals():
            if dangerous_rm_target(tok):
                blocked.append("rm -rf on root/home path (%s)" % tok)
                break
        if blocked:
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


# git s own global flags take values, and `positionals()` did not know that —
# so `git -C <path> push --force origin main` read as subcommand `<path>` and
# left before the check (review MED-4). `-C` is also the idiom our own rules
# prescribe for checking MAIN after a Coder, so the shape is a live one.
GIT_VALUE_FLAGS = {
    "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path",
    "--super-prefix", "--config-env",
}
for seg in scan.segments:
    for cand in candidates(seg):
        if cand.name != "git":
            continue
        pos = cand.positionals(GIT_VALUE_FLAGS)
        if not pos or pos[0] != "push":
            continue
        forced = any(
            f in FORCE_FLAGS or (f.startswith("-") and not f.startswith("--") and "f" in f[1:])
            for f in cand.argv if f.startswith("-")
        )
        forced = forced or any(t.startswith("+") for t in pos[1:])
        if forced and targets_protected_ref(pos[1:]):
            blocked.append("force push to main/master")
            break
    if blocked:
        break

# ── predicate 5: dropping the live database ─────────────────────────────────
# The phrase reaching a command that could execute it is the danger; the same
# phrase reaching `echo`, `gh pr create --body`, `git commit -m` or a heredoc
# that writes a file is a quotation. Unknown commands count as dangerous — the
# allowlist says what is inert, it does not enumerate what is dangerous.
DROP_RE = re.compile(r"DROP\s+DATABASE\s+(IF\s+EXISTS\s+)?[\"\x27`]?crm_db", re.I)
# Text consumers only. `sed` (GNU `e`), `awk` (`system()`), `less`/`more` (shell
# escape), `open`/`code` (hand the file to an application) were on this list and
# are not inert — `awk "BEGIN{system(\"psql -c ...\")}"` executed straight
# through it (review MED-2). `cp`/`mv`/`tee` stay: they move bytes, they do not
# run them — the write-then-execute chain below is what covers materialising a
# file and feeding it to psql in the same line.
INERT = {
    "", "echo", "printf", "cat", "tee", "gh", "git", "jq", "yq", "head", "tail",
    "grep", "egrep", "fgrep", "rg", "ag", "wc", "sort", "uniq", "cut", "tr",
    "diff", "comm", "column", "pbcopy", "true", ":", "test", "cp", "mv",
    "touch", "bat", "prettier", "date",
}
# `git -c core.pager="psql -c ..." log -1` runs psql. So does an alias set the
# same way. `git` is inert only when it is not being handed configuration.
GIT_EXEC_FLAGS = ("-c", "--config-env", "--exec-path")


def is_inert(seg):
    name = os.path.basename(seg.name)
    if name not in INERT:
        return False
    # An uncertain parse must not be able to CLAIM inertness — that direction is
    # the one that loses data.
    if not seg.confident:
        return False
    if name == "git" and any(
        t == f or t.startswith(f + "=") for t in seg.argv for f in GIT_EXEC_FLAGS
    ):
        return False
    return True


for seg in scan.segments:
    if DROP_RE.search(seg.text()) and not is_inert(seg):
        blocked.append("DROP DATABASE crm_db (исполняется через `%s`)" % (seg.name or "?"))
        break
    for cand in candidates(seg):
        if cand.name == "dropdb" and "crm_db" in cand.positionals():
            blocked.append("dropdb crm_db")
            break
    if blocked:
        break

# ── predicate 6: write the SQL in one segment, execute the file in the next ──
# `echo "DROP DATABASE crm_db;" > /tmp/x.sql && psql -f /tmp/x.sql` slipped past
# predicate 5 because each segment on its own is innocent: the first is `echo`,
# the second no longer contains the phrase. This is not the stated gap about a
# script the hook cannot read — the whole chain is right there in the line.
if not blocked:
    line_text = "\n".join(seg.text() for seg in scan.segments)
    if DROP_RE.search(line_text):
        written = {}
        for seg in scan.segments:
            argv = seg.argv
            for i, tok in enumerate(argv):
                if tok in (">", ">>", "1>", "&>") and i + 1 < len(argv):
                    written[argv[i + 1]] = seg
                elif tok.startswith(">") and len(tok.lstrip(">")) > 0:
                    written[tok.lstrip(">")] = seg
            if os.path.basename(seg.name) == "tee":
                for tok in seg.positionals(("-o",)):
                    written[tok] = seg
        for seg in scan.segments:
            if is_inert(seg):
                continue
            for tok in seg.argv:
                path = tok.lstrip("<")
                if path in written and written[path] is not seg:
                    blocked.append(
                        "DROP DATABASE crm_db записан в %s и тут же исполняется через `%s`"
                        % (path, seg.name or "?")
                    )
                    break
            if blocked:
                break

# ── the analyzer admitting it did not finish ────────────────────────────────
# `$( $( … 200 deep … ) )` walks past MAX_DEPTH and leaves code unread. Silence
# about code nobody looked at is exactly the failure mode this hook was rewritten
# for, so it refuses instead.
if not blocked and scan.truncated:
    blocked.append(
        "команда вложена глубже предела разбора — часть кода не прочитана"
    )

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
