#!/usr/bin/env bash
# test-check-hook-inline-python-size.sh — proves
# scripts/devops/check-hook-inline-python-size.py goes RED when a hook passes python3
# an inline `-c` body near the Windows command-line cap (32767 UTF-16 code units).
#
# The incident: on 2026-11-11 the analyzer of pre-bash-cross-agent-blast.sh was a
# 44186-character `python3 -c '...'` argument. Git Bash could not launch python3.exe
# with it ("Argument list too long", rc 126), the hook refused on rc != 0, and every
# Bash call on Windows was refused. Linux allows 128 KiB per argument, so every test
# on CI stayed green. This guard is the Linux-side measurement of a Windows limit.
#
# The precision cases pin the two ways a size guard under-measures: a body built from
# spliced quotes (`'...'\''...'`, where the first segment alone looks small; the live-db
# analyzer measured 30904 that way against a real 32056), and a body passed as a
# variable filled by a heredoc. The last case runs the guard on the REAL hooks.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="check-hook-inline-python-size.py"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

# $1 = case name, $2 = hook file content. Echoes the fake repo root.
make_case() {
  local name="$1" content="$2"
  local root="$WS/$name"
  guard_test_fake_repo "$root" "$GUARD"
  mkdir -p "$root/.claude/hooks"
  printf '%s' "$content" >"$root/.claude/hooks/hook.sh"
  printf '%s' "$root"
}

# $1 = number of `x = 1` lines (6 characters each with the newline)
py_lines() { awk -v n="$1" 'BEGIN { for (i = 0; i < n; i++) print "x = 1" }'; }

run_guard() { python3 "$1/scripts/devops/$GUARD"; }

SMALL="$(printf '%s\n' '#!/bin/bash' "python3 -I -B -c 'import sys' \"\$1\"")"
# 4100 lines * 6 = 24600 characters, over the 24000 budget, under the 32767 cap.
BIG_SQ="$(printf '#!/bin/bash\nprintf x | python3 -I -B -c %s\n%s\n%s\n' "'" "$(py_lines 4100)" "'")"
BIG_DQ="$(printf '#!/bin/bash\npython3 -c "\n%s\n"\n' "$(py_lines 4100)")"
# The first single-quoted segment is small; the spliced rest carries the size.
SPLICED="$(printf "#!/bin/bash\npython3 -c 'a = 1\n'\\\\''b'\\\\''\n%s\n'\n" "$(py_lines 4100)")"
HEREDOC_BIG="$(printf "#!/bin/bash\nread -r -d '' SRC <<'PY'\n%s\nPY\npython3 -I -B -c \"\$SRC\"\n" "$(py_lines 4100)")"
HEREDOC_SMALL="$(printf "#!/bin/bash\nread -r -d '' SRC <<'PY'\nimport sys\nPY\npython3 -I -B -c \"\$SRC\"\n")"
UNTRACED="$(printf '#!/bin/bash\nSRC=$(cat big.py)\npython3 -c "$SRC"\n')"
FILE_FORM="$(printf '%s\n' '#!/bin/bash' 'python3 -I -B "$SELF_DIR/lib/analyzer.py"' 'python3 -c "print(1)"')"
IN_COMMENT="$(printf "#!/bin/bash\n# python3 -c '\n%s\n# '\npython3 -c 'print(1)'\n" "$(py_lines 4100)")"
NONE="$(printf '%s\n' '#!/bin/bash' 'echo no python here')"
# Interpreter and flag spellings the first version did not see (CR-L-2 of #1314).
BIG_VERSIONED="$(printf '#!/bin/bash\npython3.12 -c %s\n%s\n%s\n' "'" "$(py_lines 4100)" "'")"
BIG_ARG_FLAGS="$(printf '#!/bin/bash\npython3 -X utf8 -Wignore -W error -c %s\n%s\n%s\n' "'" "$(py_lines 4100)" "'")"
BIG_CLUSTER="$(printf '#!/bin/bash\npython3 -IBc %s\n%s\n%s\n' "'" "$(py_lines 4100)" "'")"
SUBSTITUTED="$(printf '%s\n' '#!/bin/bash' 'python3 -c "$(cat big.py)"')"
VAR_INTERP="$(printf '%s\n' '#!/bin/bash' 'PY=python3' "\"\$PY\" -I -c 'print(1)'")"
NOT_PYTHON="$(printf '%s\n' '#!/bin/bash' '"$SHELL" -c "echo hi"' 'find "$D" -type f -exec rm {} +' "python3 -c 'print(1)'")"
# Round 2 (CR-M-1 / SR-L-1, SO-L-1, CR-L-1, CR-L-2 of #1317): options the round-1
# matcher did not know, and forms it skipped instead of reporting.
BIG_R="$(printf '#!/bin/bash\npython3 -R -c %s\n%s\n%s\n' "'" "$(py_lines 4100)" "'")"
BIG_QUOTED_X="$(printf '#!/bin/bash\npython3 -X %sutf8%s -W "ignore" -c %s\n%s\n%s\n' "'" "'" "'" "$(py_lines 4100)" "'")"
BIG_LONG="$(printf '#!/bin/bash\npython3 --check-hash-based-pycs never -I -c %s\n%s\n%s\n' "'" "$(py_lines 4100)" "'")"
VAR_FLAGS="$(printf '%s\n' '#!/bin/bash' "python3 \$FLAGS -c 'print(1)'")"
UNKNOWN_FLAG="$(printf '%s\n' '#!/bin/bash' "python3 -Z -c 'print(1)'")"
ANSI_C="$(printf '#!/bin/bash\npython3 -c $%sprint(1)%s\n' "'" "'")"
UNQUOTED_VAR="$(printf "#!/bin/bash\nread -r -d '' SRC <<'PY'\nimport sys\nPY\npython3 -c \$SRC\n")"
HOME_PY="$(printf '%s\n' '#!/bin/bash' "\"\$HOME/bin/python3\" -c 'print(1)'")"
DEFAULT_PY="$(printf '%s\n' '#!/bin/bash' "\${PY:-python3} -c 'print(1)'")"
GREP_C="$(printf '%s\n' '#!/bin/bash' 'n=$(grep "$PAT" -c "$FILE")' "python3 -c 'print(1)'")"
# Round 3 (CR-M-2, CR-L-4, sonnet L of #1317): the catch-all reports a python-like
# word before a -c that the parser did not read; a body that is only expansions is
# unmeasured; a -c after the script belongs to the script.
c_case() { printf '%s\n' '#!/bin/bash' "$1"; }
TIMEOUT_PY="$(c_case "timeout 5 \"\$PY\" -c 'print(1)'")"
XARGS_PY="$(c_case "printf x | xargs \"\$PY\" -c 'print(1)'")"
SUDO_PY="$(c_case "sudo -u root \"\$PY\" -c 'print(1)'")"
PY_EXE="$(c_case "python.exe -c 'print(1)'")"
PY_LAUNCHER="$(c_case "py -3 -c 'print(1)'")"
SPACE_PATH="$(c_case "\"/c/Program Files/Python312/python3\" -c 'print(1)'")"
SUBST_PY="$(c_case "\$(command -v python3) -c 'print(1)'")"
BODY_POSITIONAL="$(c_case 'python3 -c "$1"')"
BODY_DEFAULT="$(c_case 'python3 -c "${VAR:-}"')"
BODY_TWO_VARS="$(c_case 'python3 -c "$A$B"')"
BODY_PREFIXED="$(printf "#!/bin/bash\nread -r -d '' SRC <<'PY'\nimport sys\nPY\npython3 -c \"\$PRE\$SRC\"\n")"
SCRIPT_ARG_C="$(printf '%s\n' '#!/bin/bash' 'python3 "$SCRIPT" a -c b' "python3 -c 'print(1)'")"
# Round 4. A quoted expansion before -c, oversized body (item 3 / CR3-L-1).
BIG_OPT_PY="$(printf '#!/bin/bash\n"$PY" "$OPT" -c %s\n%s\n%s\n' "'" "$(py_lines 4100)" "'")"
BIG_OPT_PY3="$(printf '#!/bin/bash\npython3 "$OPT" -c %s\n%s\n%s\n' "'" "$(py_lines 4100)" "'")"
# git's own -c after an option argument named like PY (item 4); sudo -E keeps its catch.
GIT_PYDIR="$(printf '%s\n' '#!/bin/bash' 'git -C "$PYDIR" -c user.name=x commit' "python3 -c 'print(1)'")"
SUDO_E_PY="$(c_case "sudo -E \"\$PY\" -c 'print(1)'")"
# Any variable interpreter after a wrapper (CR3-L-2).
TIMEOUT_INTERP="$(c_case "timeout 5 \"\$INTERP\" -c 'print(1)'")"
XARGS_RUNTIME="$(c_case "printf x | xargs \"\$RUNTIME\" -c 'print(1)'")"
# The tokenizer losing the file must not hide a later form (CR3-L-3).
ARITH_SHIFT="$(printf '%s\n' '#!/bin/bash' '(( a << 2 ))' "timeout 5 \"\$PY\" -c 'print(1)'")"
SUBST_APOS="$(printf '%s\n' '#!/bin/bash' 'X=$(cat <<EOF' "it's" 'EOF' ')' "timeout 5 \"\$PY\" -c 'print(1)'")"
ANSI_ESC="$(printf '%s\n' '#!/bin/bash' "echo \$'a\\'b'" "python3 -c 'print(1)'")"
# A heredoc-filled variable spliced into program text (CR3-L-4).
BODY_SPLICED="$(printf "#!/bin/bash\nread -r -d '' SRC <<'PY'\nimport sys\nPY\npython3 -c \"import sys; \$SRC\"\n")"

# ── positive ───────────────────────────────────────────────────────────────────
assert_green "a small inline body -> green" \
  --contains "Violations found:              0" \
  -- run_guard "$(make_case small "$SMALL")"

assert_green "the fix: the program in a file, run as python3 <file> -> green" \
  --contains "Violations found:              0" \
  -- run_guard "$(make_case file-form "$FILE_FORM")"

assert_green "a small heredoc body passed as -c \"\$SRC\" is measured, and passes" \
  --contains "Violations found:              0" \
  --contains "line 5" \
  -- run_guard "$(make_case heredoc-small "$HEREDOC_SMALL")"

assert_green "a -c that opens inside a comment line is not a body" \
  --contains "Violations found:              0" \
  -- run_guard "$(make_case in-comment "$IN_COMMENT")"

# The arithmetic itself is under test, not only the verdict: 4100 * 6 + the newline
# after the opening quote = 24601.
assert_red "an exact count: a single-quoted body is measured to the character" \
  --contains "24601" \
  -- run_guard "$(make_case exact "$BIG_SQ")"

# ── negative ───────────────────────────────────────────────────────────────────
assert_red "the incident: a single-quoted body past the budget -> red" \
  --contains "OVER" \
  --contains "Argument list too long" \
  --contains "lib/<name>.py" \
  -- run_guard "$(make_case big-sq "$BIG_SQ")"

assert_red "a double-quoted body past the budget -> red" \
  --contains "OVER" \
  -- run_guard "$(make_case big-dq "$BIG_DQ")"

assert_red "a body made of spliced quotes is measured whole, not by its first segment -> red" \
  --contains "OVER" \
  -- run_guard "$(make_case spliced "$SPLICED")"

assert_red "a big heredoc body passed as -c \"\$SRC\" -> red" \
  --contains "OVER" \
  -- run_guard "$(make_case heredoc-big "$HEREDOC_BIG")"

assert_red "a -c \"\$SRC\" the guard cannot trace to a heredoc is unmeasured -> red, not a pass" \
  --contains "UNMEASURED" \
  -- run_guard "$(make_case untraced "$UNTRACED")"

assert_red "a versioned interpreter (python3.12 -c) is measured -> red" \
  --contains "OVER" \
  -- run_guard "$(make_case versioned "$BIG_VERSIONED")"

assert_red "flags with an argument before -c (-X utf8, -Wignore, -W error) are skipped -> red" \
  --contains "OVER" \
  -- run_guard "$(make_case arg-flags "$BIG_ARG_FLAGS")"

assert_red "-c at the end of a flag cluster (-IBc) is found -> red" \
  --contains "OVER" \
  -- run_guard "$(make_case cluster "$BIG_CLUSTER")"

assert_red "a body from a command substitution (-c \"\$(cat f)\") is unmeasured -> red, not a small body" \
  --contains "UNMEASURED" \
  -- run_guard "$(make_case substituted "$SUBSTITUTED")"

assert_red "a -c behind a variable interpreter (\"\$PY\" -c) is unmeasured -> red" \
  --contains "UNMEASURED" \
  -- run_guard "$(make_case var-interp "$VAR_INTERP")"

assert_green "a shell's -c and find's -exec are not python bodies -> green, one body measured" \
  --contains "Violations found:              0" \
  --contains "bodies measured: 1" \
  -- run_guard "$(make_case not-python "$NOT_PYTHON")"

assert_green "grep's -c after a variable argument is not a python body -> green, one body measured" \
  --contains "Violations found:              0" \
  --contains "bodies measured: 1" \
  -- run_guard "$(make_case grep-c "$GREP_C")"

assert_red "-R before -c is a python option (python3 -R -c) -> red" \
  --contains "OVER" \
  -- run_guard "$(make_case flag-r "$BIG_R")"

assert_red "a quoted argument after -X / -W (-X 'utf8', -W \"ignore\") is skipped -> red" \
  --contains "OVER" \
  -- run_guard "$(make_case quoted-x "$BIG_QUOTED_X")"

assert_red "a long option before -c (--check-hash-based-pycs never) is skipped -> red" \
  --contains "OVER" \
  -- run_guard "$(make_case long-opt "$BIG_LONG")"

assert_red "an option list behind a variable (python3 \$FLAGS -c) is unmeasured -> red" \
  --contains "UNMEASURED" \
  -- run_guard "$(make_case var-flags "$VAR_FLAGS")"

assert_red "an option python does not have before -c (-Z) is unmeasured -> red, not skipped" \
  --contains "UNMEASURED" \
  -- run_guard "$(make_case unknown-flag "$UNKNOWN_FLAG")"

assert_red "an ANSI-C body (-c \$'...') is unmeasured -> red" \
  --contains "UNMEASURED" \
  -- run_guard "$(make_case ansi-c "$ANSI_C")"

assert_red "an unquoted -c \$SRC is unmeasured even with a heredoc behind it -> red" \
  --contains "UNMEASURED" \
  -- run_guard "$(make_case unquoted-var "$UNQUOTED_VAR")"

assert_red "an interpreter under a variable path (\"\$HOME/bin/python3\" -c) is unmeasured -> red" \
  --contains "UNMEASURED" \
  -- run_guard "$(make_case home-py "$HOME_PY")"

assert_red "an interpreter from a default expansion (\${PY:-python3} -c) is unmeasured -> red" \
  --contains "UNMEASURED" \
  -- run_guard "$(make_case default-py "$DEFAULT_PY")"

assert_red "an expansion before -c (python3 \"\$SCRIPT\" a -c b) cannot be read: unmeasured, fail closed" \
  --contains "UNMEASURED" \
  -- run_guard "$(make_case script-arg-c "$SCRIPT_ARG_C")"

assert_red "catch-all: timeout 5 \"\$PY\" -c -> unmeasured" \
  --contains "UNMEASURED" -- run_guard "$(make_case timeout-py "$TIMEOUT_PY")"
assert_red "catch-all: xargs \"\$PY\" -c -> unmeasured" \
  --contains "UNMEASURED" -- run_guard "$(make_case xargs-py "$XARGS_PY")"
assert_red "catch-all: sudo -u root \"\$PY\" -c -> unmeasured" \
  --contains "UNMEASURED" -- run_guard "$(make_case sudo-py "$SUDO_PY")"
assert_red "catch-all: python.exe -c -> unmeasured" \
  --contains "UNMEASURED" -- run_guard "$(make_case py-exe "$PY_EXE")"
assert_red "catch-all: py -3 -c -> unmeasured" \
  --contains "UNMEASURED" -- run_guard "$(make_case py-launcher "$PY_LAUNCHER")"
assert_red "catch-all: a quoted interpreter path with a space -> unmeasured" \
  --contains "UNMEASURED" -- run_guard "$(make_case space-path "$SPACE_PATH")"
assert_red "catch-all: \$(command -v python3) -c -> unmeasured" \
  --contains "UNMEASURED" -- run_guard "$(make_case subst-py "$SUBST_PY")"

assert_red "a body that is a positional parameter (-c \"\$1\") is unmeasured, not its own text" \
  --contains "UNMEASURED" -- run_guard "$(make_case body-positional "$BODY_POSITIONAL")"
assert_red "a body that is a default expansion (-c \"\${VAR:-}\") is unmeasured" \
  --contains "UNMEASURED" -- run_guard "$(make_case body-default "$BODY_DEFAULT")"
assert_red "a body of two expansions (-c \"\$A\$B\") is unmeasured" \
  --contains "UNMEASURED" -- run_guard "$(make_case body-two-vars "$BODY_TWO_VARS")"
assert_red "a traced heredoc var behind a prefix (-c \"\$PRE\$SRC\") is unmeasured" \
  --contains "UNMEASURED" -- run_guard "$(make_case body-prefixed "$BODY_PREFIXED")"

assert_red "\"\$PY\" \"\$OPT\" -c '<oversized>' is unmeasured, not skipped (item 3)" \
  --contains "UNMEASURED" -- run_guard "$(make_case big-opt-py "$BIG_OPT_PY")"
assert_red "python3 \"\$OPT\" -c '<oversized>' is unmeasured, not skipped (CR3-L-1)" \
  --contains "UNMEASURED" -- run_guard "$(make_case big-opt-py3 "$BIG_OPT_PY3")"
assert_green "git -C \"\$PYDIR\" -c user.name=x is git's -c -> green, one body measured (item 4)" \
  --contains "Violations found:              0" \
  --contains "bodies measured: 1" \
  -- run_guard "$(make_case git-pydir "$GIT_PYDIR")"
assert_red "catch-all: sudo -E \"\$PY\" -c (an option before it, but sudo runs it) -> unmeasured" \
  --contains "UNMEASURED" -- run_guard "$(make_case sudo-e-py "$SUDO_E_PY")"
assert_red "catch-all: timeout 5 \"\$INTERP\" -c -> unmeasured (CR3-L-2)" \
  --contains "UNMEASURED" -- run_guard "$(make_case timeout-interp "$TIMEOUT_INTERP")"
assert_red "catch-all: xargs \"\$RUNTIME\" -c -> unmeasured (CR3-L-2)" \
  --contains "UNMEASURED" -- run_guard "$(make_case xargs-runtime "$XARGS_RUNTIME")"
assert_red "a shift read as a heredoc that never closes: the rest is unmeasured (CR3-L-3)" \
  --contains "UNMEASURED" -- run_guard "$(make_case arith-shift "$ARITH_SHIFT")"
assert_red "an apostrophe in a heredoc inside \$(...): the rest is unmeasured (CR3-L-3)" \
  --contains "UNMEASURED" -- run_guard "$(make_case subst-apos "$SUBST_APOS")"
assert_green "an escaped quote in \$'...' does not swallow the file -> green, one body measured" \
  --contains "Violations found:              0" \
  --contains "bodies measured: 1" \
  -- run_guard "$(make_case ansi-esc "$ANSI_ESC")"
assert_red "a heredoc-filled \$SRC inside program text is unmeasured, not its name (CR3-L-4)" \
  --contains "UNMEASURED" -- run_guard "$(make_case body-spliced "$BODY_SPLICED")"

assert_red "no inline body found at all: the scan read nothing -> red, not OK" \
  --contains "the scan read nothing" \
  -- run_guard "$(make_case none "$NONE")"

# ── the real hooks ─────────────────────────────────────────────────────────────
assert_green "every inline python3 -c body in the real .claude/hooks is under budget" \
  --contains "Violations found:              0" \
  -- python3 "$GUARD_DIR/$GUARD"

guard_test_summary "test-check-hook-inline-python-size.sh"
