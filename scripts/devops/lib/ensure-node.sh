# ensure-node.sh -- the ONE implementation of "run on the project's Node" (POSIX sh,
# meant to be SOURCED; reads .nvmrc / package.json relative to the current directory,
# which must be the repo root). Two consumers, deliberately sharing this file so the
# rule cannot drift between them:
#   - .husky/pre-push sources it and calls ensure_node before any test runs;
#   - scripts/devops/mutation-gate.mjs probes it at its single entry point
#     (`sh -c '. lib/ensure-node.sh && ensure_node && command -v node && echo $PATH'`)
#     and re-executes itself under the node it resolved. That covers the harness hook
#     pre:bash:mutation-gate (which runs the gate on the shell's own node, BEFORE git
#     starts husky), CI, and the nightly with one change.
# $ENSURE_NODE_TAG prefixes every message (default "pre-push").
#
# ensure_node -- run the gate on the project's canonical Node, never on whatever
# `node` the calling shell happens to have first on PATH (2026-10-17).
#
# Incident: two coder agents lost several push attempts each. The hook ran on the
# sandbox default (Node 20.15.1) and `@crm/shared` + `@crm/api` failed on every
# uk-catalog spec: packages/shared/src/i18n/catalog.ts loads the compiled
# `messages.ts` via `require('<path>.ts')`, which only works with Node >= 22's
# built-in type stripping (".nvmrc" = 22; "engines" = ">=22.19 <23"; rationale in
# .claude/rules/common/version-pins.md). On Node 20 that is "SyntaxError: Cannot use
# import statement outside a module". The "workaround" (warm the turbo cache from
# a Node 22 shell, then push "from cache") worked for a reason that is itself a
# hazard: turbo's task hash does NOT include the Node version, so a pass cached
# under Node 22 replays as a hit under Node 20 -- measured, identical hash
# b51541a6e1d5a75f on both. Pinning the runtime here removes the need for it.
#
# Behaviour: (1) node already satisfies .nvmrc major + engines minimum -> nothing
# to do. (2) otherwise look for a satisfying install under nvm's standard layout
# ("${NVM_DIR:-$HOME/.nvm}/versions/node/v<major>.*", derived from the
# environment, nothing machine-specific committed), prepend it to PATH and SAY SO.
# (3) otherwise REFUSE with an actionable message. There is deliberately no silent
# fallback to the wrong Node and no escape-hatch variable: a loud refusal is the
# acceptable failure mode, a green gate on the wrong runtime is not.
#
# The minimum is read from the `engines.node` field SPECIFICALLY (awk over the
# "engines" block -- node itself cannot be used to parse package.json, the whole
# premise being that the resolved node may be the wrong one), never by a regex over
# the whole file: an earlier ">=22.1.0" elsewhere (volta, overrides) must not mask
# it. Understood lower bounds: ">=22.19[.p]", "^22.19[.p]", "~22.19[.p]", "22.19[.p]"
# (minimum 19), and "22.x" / ">=22" / "^22" / "22" (minimum 0, declared by the
# author, not guessed). Upper bounds ("<23") are skipped. Anything else -- no
# engines.node, "||" ranges, a form not listed -- REFUSES: an undeterminable
# minimum must never degrade to "any v22".
#
# Called lazily (from run_full_suite and before the first scoped turbo call), not
# at the top of the file, so a docs-only push -- which needs no node at all --
# is never refused over a toolchain it does not use.
die() {
  echo "${ENSURE_NODE_TAG:-pre-push}: REFUSING to run the gate -- $1" >&2
  exit 1
}

node_ok() {
  nv="${1#v}"
  nmaj="${nv%%.*}"
  nrest="${nv#*.}"
  nmin="${nrest%%.*}"
  case "$nmaj$nmin" in *[!0-9]* | "") return 1 ;; esac
  [ "$nmaj" = "$want_major" ] && [ "$nmin" -ge "$want_minor" ]
}

engines_min() {
  # The whole file is one awk record (RS = control-A, which a JSON file cannot
  # contain); the scan walks characters from the "{" that opens the engines object
  # and stops at ITS matching "}", string-aware (a brace or quote inside a string,
  # or an escaped quote, does not count). So a one-line `"engines": {}` or
  # `{ "pnpm": "7" }` ends the scan right there and a later "node" key in another
  # block (volta, scripts) is never seen, and on a one-line object with a later
  # "node" on the same line the engines value still wins. No "node" key inside the
  # object -> empty output -> engines_min refuses.
  eng="$(awk '
    BEGIN { RS = "\001" }
    {
      s = $0
      if (!match(s, /"engines"[ \t\n\r]*:[ \t\n\r]*\{/)) exit
      p = RSTART + RLENGTH
      n = length(s)
      depth = 1
      instr = 0
      blk = ""
      while (p <= n) {
        ch = substr(s, p, 1)
        if (instr) {
          if (ch == "\\") {
            blk = blk ch substr(s, p + 1, 1)
            p += 2
            continue
          }
          if (ch == "\"") instr = 0
        } else if (ch == "\"") {
          instr = 1
        } else if (ch == "{") {
          depth++
        } else if (ch == "}") {
          depth--
          if (depth == 0) break
        }
        blk = blk ch
        p++
      }
      if (match(blk, /"node"[ \t\n\r]*:[ \t\n\r]*"[^"]*"/)) {
        v = substr(blk, RSTART, RLENGTH)
        sub(/^"node"[ \t\n\r]*:[ \t\n\r]*"/, "", v)
        sub(/"$/, "", v)
        print v
      }
    }
  ' package.json 2>/dev/null || true)"
  want_minor=""
  case "$eng" in *"||"*) eng="" ;; esac
  for t in $eng; do
    case "$t" in "<"* | ">"[!=]*) continue ;; esac
    c="${t#>=}"
    c="${c#^}"
    c="${c#\~}"
    case "$c" in
      "$want_major") m=0 ;;
      "$want_major".[xX*]) m=0 ;;
      "$want_major".[0-9]*)
        m="${c#*.}"
        m="${m%%.*}"
        ;;
      *) continue ;;
    esac
    case "$m" in "" | *[!0-9]*) continue ;; esac
    want_minor="$m"
    break
  done
  if [ -z "$want_minor" ]; then
    die "cannot determine the Node ${want_major} minimum from package.json engines.node (found: '${eng}'); supported: >=${want_major}.N, ^${want_major}.N, ~${want_major}.N, ${want_major}.N, ${want_major}.x, >=${want_major}."
  fi
}

ensure_node() {
  want_major="$(sed -n '1s/^v\{0,1\}\([0-9][0-9]*\).*/\1/p' .nvmrc 2>/dev/null || true)"
  if [ -z "$want_major" ]; then
    die "cannot read the required Node major from .nvmrc (run the push from the repo root)"
  fi
  engines_min
  cur="$(node -v 2>/dev/null || true)"
  if node_ok "$cur"; then
    return 0
  fi
  # Resolved to an ABSOLUTE path up front: a relative NVM_DIR would otherwise end up
  # as a relative PATH entry that silently points somewhere else after any `cd`.
  # (An unresolvable dir yields "" -> no candidate -> the loud refusal below.)
  nvm_root="$(cd "${NVM_DIR:-$HOME/.nvm}/versions/node" 2>/dev/null && pwd || true)"
  cand=""
  if [ -n "$nvm_root" ]; then
    # Sorted on the bare "v22.<minor>.<patch>" name, newest first, NUMERICALLY per
    # key -- never on the full path, whose own dots (e.g. /Users/first.last) would
    # shift the sort keys; and never lexically (v22.9.0 must lose to v22.10.0).
    cand="$( (cd "$nvm_root" 2>/dev/null && ls -d v"$want_major".* 2>/dev/null) | sort -t. -k2,2nr -k3,3nr | while IFS= read -r d; do
      if [ -x "$nvm_root/$d/bin/node" ] && node_ok "$("$nvm_root/$d/bin/node" -v 2>/dev/null)"; then
        echo "$nvm_root/$d/bin"
        break
      fi
    done)"
  fi
  if [ -n "$cand" ]; then
    echo "${ENSURE_NODE_TAG:-pre-push}: node ${cur:-<none>} on PATH does not satisfy Node ${want_major}.${want_minor}+ (.nvmrc / engines); using $cand for this run" >&2
    PATH="$cand:$PATH"
    export PATH
    hash -r 2>/dev/null || true
    if node_ok "$(node -v 2>/dev/null || true)"; then
      # Prepending that bin dir can also change which `pnpm` wins (an install's
      # global pnpm shadows the one the caller had). The repo pins pnpm via
      # "packageManager": "pnpm@x.y.z" (strict, version-pins.md) -- verify it
      # instead of assuming, but only here: when no switch happened pnpm
      # resolution is exactly what the caller already had.
      pnpm_pin="$(sed -n 's/^[[:space:]]*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([^"]*\)".*/\1/p' package.json 2>/dev/null | head -n 1 || true)"
      # Corepack's format appends an integrity suffix ("pnpm@7.32.4+sha512.<hex>");
      # `pnpm --version` prints only the version, so compare against the bare one.
      pnpm_pin="${pnpm_pin%%+*}"
      if [ -n "$pnpm_pin" ]; then
        pnpm_got="$(pnpm --version 2>/dev/null || true)"
        if [ "$pnpm_got" != "$pnpm_pin" ]; then
          die "after switching to $cand, pnpm resolves to '${pnpm_got:-<none>}' but package.json pins pnpm@${pnpm_pin} -- that node's global pnpm shadows the pinned one; fix it there (npm i -g pnpm@${pnpm_pin}) or put the pinned pnpm first on PATH"
        fi
      fi
      return 0
    fi
  fi
  echo "${ENSURE_NODE_TAG:-pre-push}: REFUSING to run the gate -- node ${cur:-<none>} on PATH does not satisfy Node ${want_major}.${want_minor}+ (.nvmrc / package.json engines)." >&2
  echo "${ENSURE_NODE_TAG:-pre-push}: on the wrong Node the uk-catalog specs in @crm/shared and @crm/api fail with 'Cannot use import statement outside a module'." >&2
  echo "${ENSURE_NODE_TAG:-pre-push}: install and select it, then run it again:  nvm install ${want_major} && nvm use ${want_major}   (or put a Node ${want_major} bin dir first on PATH)" >&2
  exit 1
}
