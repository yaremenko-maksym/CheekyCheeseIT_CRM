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

assert_red "no inline body found at all: the scan read nothing -> red, not OK" \
  --contains "the scan read nothing" \
  -- run_guard "$(make_case none "$NONE")"

# ── the real hooks ─────────────────────────────────────────────────────────────
assert_green "every inline python3 -c body in the real .claude/hooks is under budget" \
  --contains "Violations found:              0" \
  -- python3 "$GUARD_DIR/$GUARD"

guard_test_summary "test-check-hook-inline-python-size.sh"
