#!/bin/bash
# ECC stable id: pre:bash:mutation-gate
#
# Purpose: run the mutation gate on `git push`, on the LINES this branch changed,
# so a survived mutant is caught here instead of red on the PR — same relationship
# to `scripts/devops/mutation-gate.mjs --changed` that pre-bash-prettier-gate.sh
# has to `check-no-skip-hooks.yml`'s check-formatting job (task-mutation-gate-
# mechanical, AC1: "по образцу существующего prettier-гейта, повтори приём").
#
# WHY THIS EXISTS: the mutation gate landed 2026-08-11 (task-mutation-gate) but
# only ran in CI, i.e. by memory — an author had to remember it existed. Two PRs
# in the SAME session it was built in still went red on it in CI, because nothing
# ran it before push. That is the exact failure this hook closes.
#
# WHAT IS DIFFERENT FROM pre-bash-prettier-gate.sh, ON PURPOSE:
#   - Missing tooling is a SKIP, not a BLOCK. Prettier is cheap and its binary is
#     safely borrowed from the MAIN repo's node_modules across a worktree
#     boundary (a formatted file is a formatted file, no matter which checkout
#     re-formats it). Stryker is not safely borrowable that way: mutation-gate.mjs
#     resolves REPO_ROOT from its OWN file location and drives `git diff` from the
#     process cwd, so running MAIN's copy against a worktree's changes would mix
#     two different trees. This hook therefore requires the WORKTREE's own
#     `pnpm install` (see the project's "Worktree Provisioning Gotcha") and, when
#     that has not happened, SKIPS rather than blocking every push from a fresh
#     worktree until someone runs it. CI remains the real, unskippable gate.
#   - A "could not run" outcome (Stryker missing, packages/shared not built, the
#     gate itself hit its own error path — bad base ref, budget exceeded, crash)
#     is always a SKIP, never a BLOCK, and mirrors mutation-gate.mjs's own exit
#     code contract: 0 = pass, 1 = a REAL finding (survivor / reasonless
#     suppression) -> BLOCK, 2 = "the gate could not run" -> SKIP. Blocking a push
#     over local infrastructure would train agents to reach for the one lever this
#     whole rule set forbids (--no-verify) or to burn a session fighting the
#     runner instead of CI, which will check the real thing regardless.
#   - Every SKIP prints a banner line and states what was NOT verified — task-
#     mutation-gate-mechanical AC5 ("гейт должен уметь не запускаться заметно").
#     A silent `exit 0` here would be indistinguishable from "checked, clean",
#     which is the same failure this whole task treats: a check that cannot be
#     told apart from a check that never ran.
#
# HONEST TIME BUDGET (AC1, corrected 2026-08-18 review rounds 2 and 3 — the
# first version of this comment quoted ONE number, 3.5s-10s, sourced from
# packages/shared/apps/web measurements only. A reviewer measured apps/api
# directly and got 39-40s for a 2-line/4-mutant diff — TEN TIMES the quoted
# figure, not noise. This is now per-package AND a RANGE, not a single
# promise: round 3 re-measured that SAME 2-line/4-mutant diff a third time and
# got 53s — three runs of one fixed diff shape spanning 39-53s, a ~1.5x
# spread. A point estimate here would have been just as dishonest as the
# original 10x-off number, only by a smaller factor):
#
#   packages/shared  ~3.5-8s    for a 1-2 line / 3-5 mutant diff (measured
#                               2026-08-11 unloaded, and again 2026-08-18 under
#                               load average ~20 on 8 cores — 8.0s).
#   apps/web         ~7-10s     similar order to shared; no separate NestJS boot.
#   apps/api         ~25-53s    for a 1-2 line / 3-4 mutant diff. 24.7s
#                               measured for 1 line/3 mutants (same session,
#                               same ~20 load average as the shared row above
#                               — apps/api cost ~3x shared for an equivalently
#                               tiny diff, confirming the gap is STRUCTURAL:
#                               Stryker boots the full NestJS DI graph once
#                               per worker before it can run a single mutant,
#                               ~16-20s of the total regardless of mutant
#                               count). A 2-line/4-mutant diff measured 39s,
#                               40s, and 53s on three separate occasions — the
#                               dominant variable across those three is NOT
#                               the diff (identical each time), it is how much
#                               other concurrent agent work this shared
#                               machine was running at push time (`uptime`
#                               load averages of 15-23 on 8 cores are the
#                               ordinary case here). Treat 25-53s as the
#                               realistic range, not either endpoint as "the"
#                               number.
#
# apps/api is also the exact package where this task's motivating defects were
# found three times (task-mutation-gate-mechanical, fact 1) — the push that
# costs the most is the one doing the most-needed work, which is a real
# tradeoff, not a free lunch. See PR #572 review discussion for the judgment
# call on whether that cost is acceptable as-is.
#
# The largest recent PR (#504, 4565 changed lines) generates 2220 mutants and
# lands in budget-exceeded territory regardless of package. This hook sets a
# LOCAL budget of MUTATION_PREPUSH_BUDGET_SECONDS (default 120s) — real but not
# huge margin for apps/api specifically (measured range already ~25-53s before
# a single extra mutant beyond the measured 3-4), well above shared/web's
# typical case, below "block the developer for 15 minutes on a huge diff"
# (CI's own budget for `--changed` is 900s). If the budget is exceeded,
# mutation-gate.mjs's own budgetExceeded() reports exactly how far it got and
# how long it took — VERIFIED against a REAL apps/api overflow (not a stubbed
# one), 2026-08-18: a 1-line apps/api
# diff against a 2s budget produced a loud, correct SKIP naming the exact
# elapsed time, not a silent pass. This hook relays that as a SKIP with the two
# ways to narrow: split the push, or `MUTATION_ONLY_FILES=<path> pnpm
# mutation:changed` to check one file locally while iterating (see the
# runbook). This hook ALSO prints its own measured wall-clock duration in every
# PASS/BLOCK/SKIP banner below, so the number above is a starting estimate, not
# the only source of truth — the actual figure on YOUR push is always visible,
# not promised.
#
# WHY A WRONG RUNTIME IS THE ONE ENVIRONMENTAL CASE THAT BLOCKS (2026-10-17).
# Every "could not run" outcome used to be a SKIP, including the one where the
# gate CAN run and simply ran on the wrong Node. On Node 20 the shared i18n
# specs fail in Stryker's unmutated dry run ("Cannot use import statement
# outside a module", see scripts/devops/lib/ensure-node.sh), the gate reports
# "the suite itself is already red" and exits 2 — and the SKIP made that
# indistinguishable from an ordinary flake for days. A skip on a wrong runtime
# is exactly the silent fallback PR #1016 ruled out for the pre-push gate.
#
# The distinction this hook now draws, and where each side of it comes from:
#   - the gate is genuinely UNAVAILABLE here (no Stryker, shared not built, the
#     gate script absent, no node at all) -> SKIP, unchanged. CI is the real
#     gate; blocking every push from a fresh worktree would train agents to
#     reach for --no-verify, which is the one lever this rule set forbids.
#   - the gate is available but the RUNTIME is wrong -> BLOCK, naming the
#     version found and the version required. Not an absence to tolerate but a
#     one-command fix (`nvm use 22`), and tolerating it buys a gate whose green
#     and red both mean nothing.
#   - the gate RAN and found a survivor -> BLOCK, unchanged.
#   - the gate ran and could not finish for any OTHER reason (budget exceeded,
#     bad base ref, crash) -> SKIP, unchanged.
# The runtime verdict is NOT this hook's own opinion: it probes
# scripts/devops/lib/ensure-node.sh, the single implementation that .husky/
# pre-push sources and mutation-gate.mjs probes at its entry point (PR #1021).
# So the hook cannot drift from the gate it is protecting, and the refusal
# message an agent reads is the lib's own.
#
# Contract:
#   - Reads tool-call JSON from stdin.
#   - Fast-exit (0) on every non-`git push` command.
#   - exit 2 + JSON {decision:block, reason} in exactly two cases: the gate RAN
#     and found a real problem (survivor / reasonless suppression), or the
#     runtime it would run on is not the project's Node.
#   - exit 0 with a visible "[pre:bash:mutation-gate] SKIP" banner on stderr for
#     every case the gate could not check (nothing changed, Stryker not
#     installed here, packages/shared not built, budget exceeded, or any other
#     way mutation-gate.mjs itself could not complete).
#   - exit 0 with a visible "[pre:bash:mutation-gate] PASS" banner when it ran
#     clean.

set -u

CMD=$(python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null || true)

# Fast exit: not a `git push` invocation at all.
[ -z "$CMD" ] && exit 0
if ! echo "$CMD" | grep -qE '(^|[[:space:]])git[[:space:]]+push([[:space:]]|$)'; then
  exit 0
fi

# Skip `git push --help` / `-h`.
if echo "$CMD" | grep -qE '(^|[[:space:]])(-h|--help)([[:space:]]|$)'; then
  exit 0
fi

# Must be inside a git work tree to enforce.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

BRANCH=$(git branch --show-current 2>/dev/null || echo "")
# Detached HEAD or main/master — nothing to gate (we never push there directly).
[ -z "$BRANCH" ] && exit 0
if echo "$BRANCH" | grep -qE '^(main|master)$'; then
  exit 0
fi

WT_TOP=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
[ -z "$WT_TOP" ] && exit 0

# Wall-clock from HERE (right before the infra pre-checks), captured with
# sub-second precision via python3 (bash arithmetic is integer-only). This is
# the number that answers "how long did THIS push actually wait", printed in
# every banner below -- an observed fact, not the header comment's estimate
# (review round 2, 2026-08-18: the estimate was quoted as one number and
# measured 10x off for apps/api; a number nobody has to trust because it is
# printed fresh on every run is the actual fix, the corrected estimate is only
# a starting point).
HOOK_STARTED_AT=$(python3 -c "import time; print(time.time())" 2>/dev/null || echo "")

elapsed_s() {
  # Prints seconds.tenths since HOOK_STARTED_AT, or "?" if the clock read failed
  # (never blocks the verdict on a timing nicety).
  if [ -z "$HOOK_STARTED_AT" ]; then
    echo "?"
    return
  fi
  python3 -c "import time,sys; print(f'{time.time()-float(sys.argv[1]):.1f}')" "$HOOK_STARTED_AT" 2>/dev/null || echo "?"
}

# Appended to the PASS and SKIP banners when the runtime could not be judged
# (CR-M-3). A notice printed only before the gate ran is a notice the final line
# contradicts: the verdict an agent acts on is the last one it sees, and a plain
# PASS after an unverified runtime is the same "not checked reads as fine"
# collapse this section exists to prevent. Empty in the normal case, so the
# ordinary banner is unchanged.
runtime_caveat() {
  [ -z "${RUNTIME_UNVERIFIED:-}" ] && return
  echo "    runtime NOT verified (see above) — this verdict was produced on a Node nobody checked." >&2
}

skip() {
  # $1 = reason, $2 = optional fix instruction
  echo "[pre:bash:mutation-gate] SKIP branch=$BRANCH ($(elapsed_s)s) — $1" >&2
  echo "    NOT verified locally. CI's mutation gate (ci.yml, job quality) still runs the real check on the PR." >&2
  [ -n "${2:-}" ] && echo "    $2" >&2
  runtime_caveat
  exit 0
}

block() {
  # $1 = short reason for the JSON decision, $2 = already-printed detail (stderr only)
  python3 -c "import json,sys; print(json.dumps({'decision':'block','reason':sys.argv[1]}))" "$1" 2>/dev/null
  echo "[pre:bash:mutation-gate] BLOCK branch=$BRANCH ($(elapsed_s)s)" >&2
  exit 2
}

# ── infra pre-checks: SKIP (not block) on anything missing ──────────────────
#
# Deliberately NOT borrowed from the MAIN repo the way prettier's binary is —
# see the header. Each worktree needs its own `pnpm install`.
STRYKER_BIN="$WT_TOP/node_modules/@stryker-mutator/core/bin/stryker.js"
if [ ! -f "$STRYKER_BIN" ]; then
  skip "StrykerJS is not installed in this worktree ($STRYKER_BIN missing)." \
    "Fix: pnpm install --frozen-lockfile   (each worktree needs its own install)"
fi

SHARED_DIST="$WT_TOP/packages/shared/dist"
if [ ! -d "$SHARED_DIST" ]; then
  skip "packages/shared is not built ($SHARED_DIST missing) — apps/api and apps/web resolve @crm/shared through dist, so every mutated test run would fail before a single mutant is applied." \
    "Fix: pnpm --filter @crm/shared build"
fi

GATE="$WT_TOP/scripts/devops/mutation-gate.mjs"
if [ ! -f "$GATE" ]; then
  skip "scripts/devops/mutation-gate.mjs not found at $GATE (unexpected — did the worktree check out a commit before task-mutation-gate?)."
fi

if ! command -v node >/dev/null 2>&1; then
  skip "node is not on PATH — cannot run the gate at all."
fi

# ── the runtime: the one environmental case that BLOCKS (see the header) ────
#
# Probed BEFORE the gate runs, so a wrong Node costs ~50ms instead of the 25-53s
# the gate would spend reaching the same conclusion. Probed with THIS shell's
# PATH, which is the node the `node "$GATE"` below would use, so the hook judges
# the runtime the gate would actually get.
#
# "THE LIB SAYS NO" AND "THE LIB COULD NOT BE CONSULTED" ARE DIFFERENT ANSWERS
# (review CR-M-2). The first draft here treated every non-zero probe exit as a
# verdict, so an unreadable lib, a lib without ensure_node (127), a syntax error
# in it (2) or a missing `sh` all blocked the push while advising `nvm use 22` —
# wrong advice for a broken file, and a new way to wedge every push on an
# environment defect. The two are told apart by the lib's OWN contract:
#
#   exit 0, nothing on stderr  — the running node already satisfies .nvmrc +
#                                engines.node. Proceed.
#   exit 0, a switch notice    — a satisfying nvm install exists; mutation-
#                                gate.mjs re-executes itself under it (PR #1021),
#                                so this hook stays out of the way and lets the
#                                gate print its own notice rather than doubling it.
#   exit 1 AND the output
#   carries OUR OWN tag        — a verdict. `die` and the final refusal are the
#                                only paths in ensure-node.sh that exit 1, and
#                                both print through its documented
#                                "$ENSURE_NODE_TAG: " prefix, which THIS hook
#                                supplies. BLOCK, relaying its message.
#   anything else              — the lib could not be consulted (not readable,
#                                not sourceable, no ensure_node, no `sh`). NOT a
#                                verdict, so not a block: say so loudly and let
#                                the gate decide, exactly as when the file is
#                                absent.
#
# The tag is the discriminator rather than the exit code alone, and that is not
# belt-and-braces: a SYNTAX ERROR in the lib also exits 1 and also prints (the
# shell's own parse error), which the first draft of this check classified as a
# verdict and blocked with "nvm use 22" — wrong advice for a broken file. Found
# by the syntax-error case in the test, not by reading. Matching on a tag we set
# ourselves is a positive identification of "the lib spoke", not a guess at its
# wording.
NODE_PIN_LIB="$WT_TOP/scripts/devops/lib/ensure-node.sh"
PIN_TAG="pre:bash:mutation-gate"
RUNTIME_UNVERIFIED=""
if [ -r "$NODE_PIN_LIB" ]; then
  PIN_OUT=$(cd "$WT_TOP" && ENSURE_NODE_TAG="$PIN_TAG" sh -c '. "$1" && ensure_node' sh "$NODE_PIN_LIB" 2>&1)
  PIN_RC=$?
  if [ "$PIN_RC" -eq 1 ] && echo "$PIN_OUT" | grep -q "^$PIN_TAG: "; then
    echo "$PIN_OUT" >&2
    block "🚫 PRE-PUSH BLOCK: the mutation gate cannot run on this runtime — the message above is ensure-node.sh's own and names what was found and what is required (.nvmrc + package.json engines.node; it also refuses when the switched-to install shadows the pinned pnpm). This is deliberately a BLOCK and not a SKIP: on the wrong Node the shared i18n specs fail in Stryker's unmutated dry run, the gate reports 'the suite itself is already red', and a skip there reads exactly like an ordinary flake — that is how it hid a real defect for days on 2026-10-17. Fix what the message asks (usually: nvm install 22 && nvm use 22, or a Node 22 bin dir first on PATH), then push again."
  elif [ "$PIN_RC" -ne 0 ]; then
    [ -n "$PIN_OUT" ] && echo "$PIN_OUT" >&2
    RUNTIME_UNVERIFIED="the Node pin could not be consulted: $NODE_PIN_LIB exited $PIN_RC without saying anything as $PIN_TAG (not sourceable, a syntax error, no ensure_node function, or no \`sh\`). Fix the library, not your Node."
  fi
else
  RUNTIME_UNVERIFIED="$NODE_PIN_LIB is missing or unreadable (a checkout older than PR #1021?)."
fi

# Not a skip: the gate can still find survivors, and refusing a push over a
# broken library would be the hard block the header rules out. But it is said OUT
# LOUD, here AND again in the final banner (CR-M-3), because "the runtime was not
# checked" must not read like "the runtime is fine" — that collapse is the whole
# defect this section fixes, and a notice that scrolls past before a 50-second
# gate run has already lost the argument.
if [ -n "$RUNTIME_UNVERIFIED" ]; then
  echo "[pre:bash:mutation-gate] runtime NOT verified — $RUNTIME_UNVERIFIED Running the gate anyway; a failure naming 'Cannot use import statement outside a module' is a wrong-Node symptom, not a flake." >&2
fi

# ── run it ────────────────────────────────────────────────────────────────
#
# `--changed` mutates only the lines this branch changed vs its base, exactly
# like mutation-gate.mjs's own resolveBase() computes for CI. A local budget
# well above the honest typical case (see header) — the gate itself reports
# exactly what happened if it runs out.
BUDGET="${MUTATION_PREPUSH_BUDGET_SECONDS:-120}"
OUT=$(cd "$WT_TOP" && MUTATION_BUDGET_SECONDS="$BUDGET" node "$GATE" --changed 2>&1)
RC=$?

# Always shown — this is the evidence, not just the verdict (same discipline as
# run_prettier_check() in the prettier gate: the tool's own report is what a
# developer trusts, not a one-line summary of it).
echo "$OUT" >&2

case "$RC" in
  0)
    echo "[pre:bash:mutation-gate] PASS branch=$BRANCH ($(elapsed_s)s)" >&2
    runtime_caveat
    exit 0
    ;;
  1)
    # The gate RAN and found a real problem: a surviving mutant, or a
    # suppression with no usable reason. This is the one case that blocks.
    block "🚫 PRE-PUSH BLOCK: mutation gate found a real problem in changed code — see output above (a surviving mutant, or a suppression with no written reason). Fix it, or suppress WITH a reason: // Stryker disable next-line <mutator>: <why this mutant cannot be killed>. Runbook: scripts/devops/mutation-gate-runbook.md."
    ;;
  *)
    # Exit 2 from mutation-gate.mjs means, by its own documented contract,
    # "the gate could not run" — bad base ref, Stryker crashed, the unmutated
    # suite was already red, or the local budget was exceeded. None of those
    # are a finding; see the header for why this is a SKIP, not a BLOCK.
    skip "mutation gate could not complete locally (exit $RC) — see its own output above for the reason." \
      "Manual full check: MUTATION_BUDGET_SECONDS=900 node scripts/devops/mutation-gate.mjs --changed   |   narrow while iterating: MUTATION_ONLY_FILES=<path[:from-to]> node scripts/devops/mutation-gate.mjs --changed"
    ;;
esac
