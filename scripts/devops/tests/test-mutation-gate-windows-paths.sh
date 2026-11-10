#!/usr/bin/env bash
# test-mutation-gate-windows-paths.sh -- proves scripts/devops/mutation-gate.mjs compares
# paths in a form that also holds on Windows (2026-11-10).
#
# WHY THIS EXISTS: on Windows `node mutation-gate.mjs ...` exited 0 with no output and no
# report. The entry-point guard compared import.meta.url (file:///C:/...) with a string
# built as `file://${process.argv[1]}` (file://C:\...), so the main block never ran -- an
# exit 0 without the artifact. The node-pin check had the same family of defect: Git Bash
# prints /c/x/bin/node while process.execPath is C:\x\bin\node.exe.
#
# HOW: both comparisons are exported pure functions with the platform as a parameter, so
# the Windows shapes are exercised on any runner. Against the pre-fix script every case
# fails: the functions do not exist and the import throws.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GATE="$GUARD_DIR/mutation-gate.mjs"
# Git Bash: native node imports only file:///C:/... there (no-op where cygpath is absent).
if command -v cygpath >/dev/null 2>&1; then GATE="file:///$(cygpath -m "$GATE")"; fi

echo "== test-mutation-gate-windows-paths.sh =="
echo

# entry <import.meta.url> <argv1> <windows: true|false> -- exit 0 iff it is the entry point.
entry() {
  MSYS_NO_PATHCONV=1 node --input-type=module -e "
import { isEntryPoint } from '$GATE'
const r = isEntryPoint(process.argv[1], process.argv[2], process.argv[3] === 'true')
console.log('ENTRY=' + r)
process.exit(r ? 0 : 1)
" "$@"
}

# same <a> <b> <platform> -- exit 0 iff both name the same executable.
same() {
  MSYS_NO_PATHCONV=1 node --input-type=module -e "
import { samePath } from '$GATE'
const r = samePath(process.argv[1], process.argv[2], process.argv[3])
console.log('SAME=' + r)
process.exit(r ? 0 : 1)
" "$@"
}

# 1 -- the incident: a Windows argv[1] against its own file URL is the entry point.
assert_green "windows argv C:\\repo\\gate.mjs vs file:///C:/repo/gate.mjs -> entry point" \
  --contains "ENTRY=true" \
  -- entry 'file:///C:/repo/scripts/devops/mutation-gate.mjs' 'C:\repo\scripts\devops\mutation-gate.mjs' true

# 2 -- POSIX behaviour is unchanged.
assert_green "posix argv /repo/gate.mjs vs file:///repo/gate.mjs -> entry point" \
  --contains "ENTRY=true" \
  -- entry 'file:///repo/scripts/devops/mutation-gate.mjs' '/repo/scripts/devops/mutation-gate.mjs' false

# 3 -- a space in the path is percent-encoded in the URL; the old template string missed it.
assert_green "posix path with a space -> still the entry point" \
  --contains "ENTRY=true" \
  -- entry 'file:///my%20repo/mutation-gate.mjs' '/my repo/mutation-gate.mjs' false

# 4 -- an importer (argv[1] is another file) must NOT run main().
assert_red "windows argv naming another file -> not the entry point" \
  --contains "ENTRY=false" \
  -- entry 'file:///C:/repo/scripts/devops/mutation-gate.mjs' 'C:\repo\other.mjs' true
assert_red "posix argv naming another file -> not the entry point" \
  --contains "ENTRY=false" \
  -- entry 'file:///repo/scripts/devops/mutation-gate.mjs' '/repo/other.mjs' false

# 5 -- the node pin: on win32 the drive-letter case and the .exe suffix do not matter.
assert_green "win32: C:\\x\\bin\\node vs c:\\X\\bin\\node.exe -> same executable" \
  --contains "SAME=true" \
  -- same 'C:\x\bin\node' 'c:\X\bin\node.exe' win32

# 6 -- different installs are still different on win32, and POSIX stays case-sensitive.
assert_red "win32: v20 node vs v22 node -> different executables (no false continue)" \
  --contains "SAME=false" \
  -- same 'C:\nvm\v20\bin\node.exe' 'C:\nvm\v22\bin\node.exe' win32
assert_red "linux: /X/node vs /x/node -> different (case-sensitive, unchanged)" \
  --contains "SAME=false" \
  -- same '/X/node' '/x/node' linux

# 7 -- CR-L-1: invoked through a link, argv[1] keeps the link while import.meta.url is the
# resolved file. Git Bash `ln -s` copies instead of linking, so this case needs a POSIX
# host (CI); the Windows junction shape was checked by hand (PR #1308 body).
if command -v cygpath >/dev/null 2>&1; then
  echo "SKIP  symlinked script dir (no real symlinks under Git Bash; runs on the Linux runner)"
else
  WS="$(guard_test_workspace)"
  WS="$(cd -P "$WS" && pwd)"
  trap 'rm -rf "$WS"' EXIT
  mkdir -p "$WS/real"
  : >"$WS/real/mutation-gate.mjs"
  ln -s "$WS/real" "$WS/link"
  assert_green "argv[1] through a symlinked dir vs the resolved file URL -> entry point" \
    --contains "ENTRY=true" \
    -- entry "file://$WS/real/mutation-gate.mjs" "$WS/link/mutation-gate.mjs" false
fi

# withExe <platform> <nodePath> <exists: yes|no> -- prints the path the re-exec would spawn.
with_exe() {
  MSYS_NO_PATHCONV=1 node --input-type=module -e "
import { withExe } from '$GATE'
console.log('NODE=' + withExe(process.argv[1], process.argv[2], (p) => process.argv[3] === 'yes' && p === process.argv[2] + '.exe'))
" "$@"
}

# 8 -- CR-L-2: on win32 the probe's extension-less node gets .exe only when that file exists.
assert_green "win32 + node.exe exists -> .exe appended" \
  --contains 'NODE=C:\x\bin\node.exe' \
  -- with_exe win32 'C:\x\bin\node' yes
assert_green "win32 + already .exe -> unchanged" \
  --contains 'NODE=C:\x\bin\node.exe' \
  --not-contains 'node.exe.exe' \
  -- with_exe win32 'C:\x\bin\node.exe' yes
assert_green "win32 + no node.exe beside it -> unchanged (append only what exists)" \
  --contains 'NODE=C:\x\bin\node' \
  --not-contains 'node.exe' \
  -- with_exe win32 'C:\x\bin\node' no
assert_green "linux + a node.exe beside it -> unchanged (no .exe on POSIX)" \
  --contains 'NODE=/x/bin/node' \
  --not-contains 'node.exe' \
  -- with_exe linux '/x/bin/node' yes

guard_test_summary "test-mutation-gate-windows-paths.sh"
