#!/usr/bin/env bash
# cloudflare-ips-watch.sh — twice-daily sentinel (task-cloudflare-ips-watch,
# 2026-08-18): decides what to DO with a Cloudflare IP-range drift, and does
# it. Called by .github/workflows/cloudflare-ips-watch.yml.
#
# WHY THIS EXISTS NOW, NOT BEFORE: the owner applied the Hetzner network
# firewall the same day this script was written
# (docs/runbooks/origin-mtls-and-firewall.md §1), restricting :80/:443 to
# Cloudflare's published ranges ONLY. Before that firewall, a stale
# nginx/cloudflare-ips.txt was noise in logs. After it, a range Cloudflare
# adds and this file lacks means real visitors arriving via that range get a
# connection timeout — and the owner, testing from their own machine, is
# very unlikely to be the one who hits it (see check-cloudflare-ips-
# freshness.sh's own header for exactly which visitors are affected and
# why). `scripts/devops/check-cloudflare-ips-freshness.sh` already existed
# as an on-demand precondition check for a DIFFERENT procedure (flipping
# ORIGIN_GATE_MODE); it was never wired to a schedule because until today
# staleness was not urgent enough to justify a recurring job. It now is.
#
# THIS SCRIPT DOES NOT RE-IMPLEMENT THE COMPARISON. `check-cloudflare-ips-
# freshness.sh` is the ONE place that fetches cloudflare.com/ips-v4|v6 and
# diffs them against the repo file — this script calls it and acts on its
# ADDED_OUT/REMOVED_OUT/exit-code contract (see that script's header). Two
# independent implementations of "fetch + diff
# Cloudflare's ranges" is exactly the kind of thing that drifts apart
# unnoticed — the project has hit that class of bug before (two descriptions
# of one zone, each individually looking right) and this repo's own guard-
# test discipline exists to stop it from happening quietly a second time.
#
# WHAT IT DOES, given the sub-check's outcome:
#   exit 0 (fresh)     -> print a one-line confirmation, exit 0. NOTHING ELSE
#                         — no issue, no PR, no comment. A quiet guard is the
#                         only kind anyone keeps reading (AC6).
#   exit 1 (drifted)   -> classify ADDED (Cloudflare published a range this
#                         repo lacks — URGENT, visitors on that range time
#                         out TODAY) vs REMOVED (repo has a range Cloudflare
#                         no longer publishes — cleanup, not urgent, grants
#                         nobody anything). Open/update a PR that rewrites
#                         nginx/cloudflare-ips.txt to match Cloudflare
#                         exactly, and open/update an issue — assigned to
#                         the owner, so GitHub's own "assigned" email
#                         notification is the delivery channel; no SMTP
#                         secret exists anywhere in this repo and none is
#                         being added — with copy-pasteable CIDR lists and
#                         the exact Hetzner console steps (AC5).
#   anything else      -> the SENTINEL itself is broken (source unreachable,
#                         empty response, unparseable). This is explicitly
#                         NOT treated as "no drift" — it fails LOUD (nonzero
#                         exit, ::error:: annotation) so the scheduled run
#                         goes red in Actions, which is what triggers
#                         GitHub's native "your scheduled workflow failed"
#                         notification email to the repo owner — again, no
#                         extra secret, no extra channel (AC7).
#
# AUTOMERGE IS NEVER SET on the PR this opens — a range change is exactly
# the kind of diff a human should actually look at before it reaches prod
# nginx config generation (AC3). Nothing in this script ever adds the
# `merge-approved` label or touches auto-merge-on-label.yml's trigger.
#
# NEVER pushes to main, never uses an owner PAT, never runs `git push`
# against a branch protection bypass — everything lands on a single
# bot-owned feature branch (PR_BRANCH) via a PR, same shape every run. See
# .github/workflows/e2e-watchdog.yml's header for the exact class of
# self-triggering-deploy incident this design avoids by construction (no
# direct main push at all, so there is nothing to self-trigger).
#
# Required env:
#   REPO           owner/name of the repo receiving the PR + issue
#   OWNER_LOGIN    GitHub login to assign the issue to (email delivery relies
#                  entirely on GitHub's own "you were assigned" notification
#                  — see AC4, no SMTP secret involved)
# Optional env:
#   CF_IPS_FILE       path to the repo's CF ranges file
#                     (default: <repo root>/nginx/cloudflare-ips.txt)
#   FRESHNESS_CHECK   path to check-cloudflare-ips-freshness.sh
#                     (default: sibling of this script)
#   GH_BIN            `gh` binary to invoke (default: gh) — overridable so
#                     tests can point it at a stub, same convention as
#                     check-required-checks-complete.sh
#   BASE_BRANCH       branch the PR targets (default: main)
#   PR_BRANCH         the single bot-owned branch this script pushes to
#                     (default: infra/cloudflare-ips-auto-update) — reused
#                     across runs, never accumulates parallel branches
#   DRY_RUN           1 -> compute and PRINT everything (issue body, PR
#                     body, the exact diff, the gh/git commands that would
#                     run) without touching git or the network beyond the
#                     freshness sub-check's own fetch. This is how the guard
#                     test below proves the three required scenarios without
#                     a real GitHub repo or a real git remote.
#   DRY_RUN_OPEN_PR   dry-run only — supply a fake existing-PR number to
#                     exercise the "update, don't duplicate" branch (same
#                     pattern post-merge-alert.sh uses for DRY_RUN_OPEN_ISSUE)
#   DRY_RUN_OPEN_ISSUE  dry-run only — same, for the issue
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

CF_IPS_FILE="${CF_IPS_FILE:-$REPO_ROOT/nginx/cloudflare-ips.txt}"
FRESHNESS_CHECK="${FRESHNESS_CHECK:-$SCRIPT_DIR/check-cloudflare-ips-freshness.sh}"
GH_BIN="${GH_BIN:-gh}"
BASE_BRANCH="${BASE_BRANCH:-main}"
PR_BRANCH="${PR_BRANCH:-infra/cloudflare-ips-auto-update}"
DRY_RUN="${DRY_RUN:-0}"
RUNBOOK_PATH="docs/runbooks/origin-mtls-and-firewall.md"
ISSUE_TITLE_MARKER="Диапазоны Cloudflare изменились"

for var in REPO OWNER_LOGIN; do
  if [ -z "${!var:-}" ]; then
    echo "::error::cloudflare-ips-watch.sh: required env \$$var is empty" >&2
    exit 2
  fi
done

if [ ! -f "$FRESHNESS_CHECK" ]; then
  echo "::error::cloudflare-ips-watch.sh: FRESHNESS_CHECK not found at $FRESHNESS_CHECK" >&2
  exit 2
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# NOTE: deliberately NOT `%q`-quoted (unlike post-merge-alert.sh's run_gh).
# `%q` byte-escapes anything it treats as needing quoting, which for a
# multi-byte UTF-8 string (every Cyrillic body/title this script builds)
# means each byte comes out as an individual `\NNN` octal escape — a
# multi-paragraph Russian issue body turns into a wall of octal digits, in
# both a human's terminal AND in `grep` matching against this output. This
# is a PREVIEW of intent, not a paste-able command (the bodies are pages
# long) — plain `$*` keeps the actual title/body text legible, which matters
# more here than exact shell re-quotability.
run_gh() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '[dry-run] gh %s\n' "$*"
    return 0
  fi
  "$GH_BIN" "$@"
}

run_git() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '[dry-run] git %s\n' "$*"
    return 0
  fi
  git "$@"
}

# ── 1. reuse check-cloudflare-ips-freshness.sh — the ONE comparison ────────────
ADDED_FILE="$WORKDIR/added.txt"
REMOVED_FILE="$WORKDIR/removed.txt"

set +e
FRESH_OUTPUT="$(ADDED_OUT="$ADDED_FILE" REMOVED_OUT="$REMOVED_FILE" \
  bash "$FRESHNESS_CHECK" "$CF_IPS_FILE" 2>&1)"
FRESH_RC=$?
set -e

echo "$FRESH_OUTPUT" | sed 's/^/[freshness-check] /'
echo

case "$FRESH_RC" in
  0)
    echo "cloudflare-ips-watch: no drift — nginx/cloudflare-ips.txt matches Cloudflare. Quiet exit, nothing opened."
    exit 0
    ;;
  1)
    : # drifted — proceed below
    ;;
  *)
    echo "::error::cloudflare-ips-watch: check-cloudflare-ips-freshness.sh could NOT verify freshness (exit $FRESH_RC) — the source is unreachable or returned something unparseable. This is a BROKEN SENTINEL, not \"no drift\" — failing loud so the scheduled run goes red." >&2
    exit 1
    ;;
esac

# ── 2. classify ────────────────────────────────────────────────────────────────
ADDED_LIST="$(cat "$ADDED_FILE" 2>/dev/null || true)"
REMOVED_LIST="$(cat "$REMOVED_FILE" 2>/dev/null || true)"

# security review PR #557 (MED): `[ -f "$ADDED_FILE" ] && grep -c . "$ADDED_FILE"
# || echo 0` looked reasonable and broke on the MOST COMMON real case — an
# empty file (pure "removed-only" or pure "added-only" drift, i.e. exactly
# ONE of the two files has zero entries). `grep -c .` on zero matches prints
# "0" to stdout AND exits 1 (its normal "nothing matched" signal) — the `&&`
# chain sees that exit 1 as failure and ALSO runs `|| echo 0`, so the
# variable ends up holding TWO lines ("0\n0"), not one. `[ "$ADDED_COUNT"
# -gt 0 ]` then errors ("integer expression expected", caught by actually
# running this against a removed-only fixture, not by reading the code) and
# the count leaks a literal newline into the git commit subject
# ("...auto, added=0\n0 removed=1)").
#
# `grep -c '^'` (same idiom the paired check-cloudflare-ips-freshness.sh now
# uses, for the same reason) always prints exactly ONE line — but this
# script runs under `set -euo pipefail` (that one does not), so grep's exit
# 1 on zero matches would otherwise abort the whole watcher right here,
# silently, on the most common input (confirmed by actually running a bare
# `x=$(grep -c '^' <empty-file>)` under `set -e` — it exits before the next
# line ever runs, no error message, nothing). The trailing `|| true` is not
# decorative: it is what keeps the exit-1-on-zero-matches case from being
# `set -e`'s problem instead of this function's.
count_lines() { grep -c '^' "$1" || true; }
ADDED_COUNT="$(count_lines "$ADDED_FILE")"
REMOVED_COUNT="$(count_lines "$REMOVED_FILE")"

if [ "$ADDED_COUNT" -gt 0 ]; then
  SEVERITY="urgent"
else
  SEVERITY="cleanup"
fi

echo "cloudflare-ips-watch: drift found — added=$ADDED_COUNT removed=$REMOVED_COUNT severity=$SEVERITY"

# ── 3. rebuild nginx/cloudflare-ips.txt — SURGICAL patch, not wholesale ────────
# regeneration: keep every existing line's position, drop exactly the
# REMOVED entries, append exactly the ADDED entries. Deliberately NOT built
# from a fresh copy of Cloudflare's own publish order (which check-
# cloudflare-ips-freshness.sh does not even hand back, see its header) —
# that order is not guaranteed stable between fetches, and rebuilding from
# it wholesale turns a single real change into a fully-reshuffled diff no
# reviewer can read at a glance. A minimal diff is not a cosmetic nicety
# here — AC3 exists so a human actually looks at this before merge, and a
# human cannot meaningfully review 22 reordered lines to find the 1 that
# matters.
if ! grep -qE '^[0-9A-Fa-f:.]+/[0-9]+[[:space:]]*$' "$CF_IPS_FILE"; then
  echo "::error::cloudflare-ips-watch: could not find a single CIDR-shaped line in $CF_IPS_FILE — refusing to guess where the header ends (format may have changed)." >&2
  exit 1
fi

HEADER_FILE="$WORKDIR/header.txt"
# Header = every line up to (not including) the first CIDR-shaped line — the
# real file's header ends immediately before its first range with no blank
# separator, and that is exactly what this reproduces.
awk '/^[0-9A-Fa-f:.]+\/[0-9]+[[:space:]]*$/{exit} {print}' "$CF_IPS_FILE" >"$HEADER_FILE"

# Existing CIDR lines, comments/blanks stripped, ORIGINAL FILE ORDER
# preserved (not sorted) — split into v4/v6 by the same `:` presence test
# used everywhere else in this pair of scripts.
REPO_V4_FILE="$WORKDIR/repo-v4-ordered.txt"
REPO_V6_FILE="$WORKDIR/repo-v6-ordered.txt"
grep -v '^[[:space:]]*#' "$CF_IPS_FILE" | grep -v '^[[:space:]]*$' | grep -v ':' >"$REPO_V4_FILE" || true
grep -v '^[[:space:]]*#' "$CF_IPS_FILE" | grep -v '^[[:space:]]*$' | grep ':' >"$REPO_V6_FILE" || true

NEW_V4_FILE="$WORKDIR/new-v4.txt"
NEW_V6_FILE="$WORKDIR/new-v6.txt"
if [ -s "$REMOVED_FILE" ]; then
  grep -v -F -x -f "$REMOVED_FILE" "$REPO_V4_FILE" >"$NEW_V4_FILE" || true
  grep -v -F -x -f "$REMOVED_FILE" "$REPO_V6_FILE" >"$NEW_V6_FILE" || true
else
  cp "$REPO_V4_FILE" "$NEW_V4_FILE"
  cp "$REPO_V6_FILE" "$NEW_V6_FILE"
fi
if [ -s "$ADDED_FILE" ]; then
  grep -v ':' "$ADDED_FILE" >>"$NEW_V4_FILE" || true
  grep ':' "$ADDED_FILE" >>"$NEW_V6_FILE" || true
fi

NEW_FILE="$WORKDIR/new-cloudflare-ips.txt"
{
  cat "$HEADER_FILE"
  cat "$NEW_V4_FILE"
  cat "$NEW_V6_FILE"
} >"$NEW_FILE"

DIFF_OUTPUT="$(diff -u "$CF_IPS_FILE" "$NEW_FILE" || true)"

# ── 4. build the copy-pasteable lists + issue/PR text (AC5) ────────────────────
fmt_list() {
  # $1 = raw newline-separated CIDRs (may be empty)
  if [ -z "$1" ]; then
    echo "_(нет)_"
  else
    printf '```\n%s\n```\n' "$1"
  fi
}

if [ "$SEVERITY" = "urgent" ]; then
  ISSUE_TITLE="🚨 СРОЧНО: $ISSUE_TITLE_MARKER — обнови файрвол Hetzner"
else
  ISSUE_TITLE="🧹 $ISSUE_TITLE_MARKER — устаревшая запись в файрволе"
fi

PR_TITLE="chore(infra): sync Cloudflare IP ranges (auto)"

# ── 5. PR: open/update on the single bot-owned branch (AC3) ────────────────────
if [ "$DRY_RUN" = "1" ]; then
  EXISTING_PR="${DRY_RUN_OPEN_PR:-}"
else
  # Read-only lookup — called directly (not via run_gh, which exists only to
  # make MUTATING calls dry-runnable). Real execution only; DRY_RUN takes the
  # override above instead, same reasoning as post-merge-alert.sh's OPEN var.
  EXISTING_PR="$("$GH_BIN" pr list --repo "$REPO" --head "$PR_BRANCH" --state open --json number --jq '.[0].number // empty')"
fi

PR_BODY=$(
  printf '## Cloudflare опубликовал изменение диапазонов\n\n'
  printf 'Автоматически создано `cloudflare-ips-watch.yml` (дважды в сутки) — обновляет\n'
  printf '`nginx/cloudflare-ips.txt` до точного соответствия `cloudflare.com/ips-v4` +\n'
  printf '`/ips-v6`.\n\n'
  printf '**Добавились (нет в файле — визитёры с этих диапазонов таймаутят СЕЙЧАС):**\n\n'
  fmt_list "$ADDED_LIST"
  printf '\n**Пропали (Cloudflare больше не публикует — уборка, доступа не даёт):**\n\n'
  fmt_list "$REMOVED_LIST"
  printf '\n<details><summary>Полный diff</summary>\n\n```diff\n%s\n```\n\n</details>\n\n' "$DIFF_OUTPUT"
  printf '## Не автомерджить\n\n'
  printf 'Правку диапазонов файрвола смотрит человек — на этом PR НЕТ label `merge-approved`,\n'
  printf 'и этот workflow его никогда не добавляет.\n\n'
  printf '## Отдельно: правило в консоли Hetzner\n\n'
  printf 'Этот PR правит только nginx (`set_real_ip_from` + origin-gate). Правило файрвола\n'
  printf 'Hetzner Cloud (порты 80 и 443) меняется владельцем РУКАМИ в консоли — см. связанную\n'
  printf 'issue (заведена этим же прогоном) для готовых списков и шагов. См. также `%s`.\n\n' "$RUNBOOK_PATH"
  printf '## Если CI на этом PR не запустился\n'
  printf 'Пуш от `GITHUB_TOKEN` не тригерит workflow-события (анти-loop GitHub) — если проверки\n'
  printf 'пустые, прогони вручную: `gh workflow run ci.yml --ref %s`.\n' "$PR_BRANCH"
)

# `cp` here writes the REAL tracked file — under DRY_RUN this must be
# skipped entirely, not just have its downstream `git add/commit/push`
# no-op'd via run_git, or a dry-run invocation silently mutates the working
# tree it was asked not to touch (caught by hand while smoke-testing this
# script against a fixture file — the second "clean" run was clean only
# because the first dry-run had already overwritten the fixture).
write_new_file() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '[dry-run] would write %s (see diff above)\n' "$CF_IPS_FILE"
    return 0
  fi
  cp "$NEW_FILE" "$CF_IPS_FILE"
}

if [ "$DRY_RUN" != "1" ]; then
  # Same bot identity convention as e2e-watchdog.yml's (disabled) auto-commit
  # step — required or a bare `git commit` errors "Please tell me who you
  # are" on a fresh Actions runner checkout. Skipped entirely under DRY_RUN
  # so a test run never touches a real checkout's git config.
  git config user.name "github-actions[bot]"
  git config user.email "github-actions[bot]@users.noreply.github.com"
fi

if [ -z "$EXISTING_PR" ]; then
  run_git fetch origin "$PR_BRANCH" || true
  run_git checkout -B "$PR_BRANCH"
  write_new_file
  run_git add "$CF_IPS_FILE"
  run_git commit -m "chore(infra): sync Cloudflare IP ranges (auto, added=$ADDED_COUNT removed=$REMOVED_COUNT)"
  run_git push --force-with-lease origin "HEAD:$PR_BRANCH"
  PR_URL="$(run_gh pr create --repo "$REPO" --base "$BASE_BRANCH" --head "$PR_BRANCH" \
    --title "$PR_TITLE" --body "$PR_BODY")"
  echo "cloudflare-ips-watch: opened new PR: $PR_URL"
else
  run_git fetch origin "$PR_BRANCH" || true
  run_git checkout -B "$PR_BRANCH" "origin/$PR_BRANCH"
  write_new_file
  run_git add "$CF_IPS_FILE"
  run_git commit -m "chore(infra): sync Cloudflare IP ranges (auto, added=$ADDED_COUNT removed=$REMOVED_COUNT)" || true
  run_git push --force-with-lease origin "HEAD:$PR_BRANCH"
  run_gh pr edit "$EXISTING_PR" --repo "$REPO" --title "$PR_TITLE" --body "$PR_BODY"
  PR_URL="$(run_gh pr view "$EXISTING_PR" --repo "$REPO" --json url --jq .url)"
  echo "cloudflare-ips-watch: updated existing PR #$EXISTING_PR: $PR_URL"
fi
[ "$DRY_RUN" = "1" ] && [ -z "${PR_URL:-}" ] && PR_URL="(dry-run — no real URL)"

# ── 6. issue: open/update, assigned to the owner (AC4) ──────────────────────────
if [ "$DRY_RUN" = "1" ]; then
  EXISTING_ISSUE="${DRY_RUN_OPEN_ISSUE:-}"
else
  # `gh ... --jq` takes one expression string, no separate `--arg` — the
  # marker is a fixed constant this script defines (not external input), so
  # it is embedded directly rather than piped through a second `jq` process.
  EXISTING_ISSUE="$("$GH_BIN" issue list --repo "$REPO" --state open --json number,title \
    --jq "[.[] | select(.title | contains(\"$ISSUE_TITLE_MARKER\"))][0].number // empty")"
fi

ISSUE_BODY=$(
  if [ "$SEVERITY" = "urgent" ]; then
    printf '> ⚠️ **СРОЧНО.** Cloudflare опубликовал диапазон, которого нет в правиле файрвола\n'
    printf '> Hetzner — часть посетителей уже получает таймаут на порт 80/443.\n\n'
  else
    printf '> 🧹 Уборка. Cloudflare больше не публикует диапазон, который есть в правиле\n'
    printf '> файрвола. Лишнее разрешение, доступа никому не даёт — можно убрать не спеша.\n\n'
  fi
  printf '## Добавились (готовый список для вставки в Hetzner)\n\n'
  fmt_list "$ADDED_LIST"
  printf '\n## Пропали (готовый список для удаления из Hetzner)\n\n'
  fmt_list "$REMOVED_LIST"
  printf '\n## Что сделать в консоли Hetzner Cloud\n\n'
  printf '1. **Firewalls** → нужный файрвол → правила на порт **80** → добавить/убрать\n'
  printf '   диапазоны выше.\n'
  printf '2. Повторить **то же самое** для правила на порт **443** — оба правила держат\n'
  printf '   отдельные списки источников, поменять надо ОБА.\n'
  printf '3. Не пропускать IPv6-диапазоны — Cloudflare публикует оба семейства, и\n'
  printf '   правило должно закрывать оба.\n\n'
  printf '## Отдельный PR\n\n'
  printf 'PR, обновляющий `nginx/cloudflare-ips.txt` (для `set_real_ip_from` и origin-gate),\n'
  printf 'уже открыт: %s — его тоже надо смёржить, отдельно от правки в консоли Hetzner.\n\n' "$PR_URL"
  printf 'Подробности и связь между файрволом и nginx-фильтром — `%s`.\n' "$RUNBOOK_PATH"
)

if [ -z "$EXISTING_ISSUE" ]; then
  run_gh issue create --repo "$REPO" --title "$ISSUE_TITLE" --body "$ISSUE_BODY" --assignee "$OWNER_LOGIN"
  echo "cloudflare-ips-watch: opened new issue, assigned to $OWNER_LOGIN"
else
  run_gh issue edit "$EXISTING_ISSUE" --repo "$REPO" --title "$ISSUE_TITLE" --body "$ISSUE_BODY" --add-assignee "$OWNER_LOGIN"
  echo "cloudflare-ips-watch: updated existing issue #$EXISTING_ISSUE, ensured assignee $OWNER_LOGIN"
fi

echo
echo "=== DIFF (for reference) ==="
echo "$DIFF_OUTPUT"
