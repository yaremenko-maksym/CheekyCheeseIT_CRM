#!/usr/bin/env bash
# test-check-no-russian-letters.sh — proves scripts/devops/check-no-russian-letters.mjs
# goes RED on Russian-only letters (ы э ъ ё) in apps/api string literals and in the
# uk/en catalogs, and — the case that matters most — stays GREEN on Ukrainian.
#
# THE KEY GREEN: Ukrainian text ("обліковий", "Команда", "Київ", "зобов'язання")
# must NOT be flagged. A byte-wise `grep '[ыэъё]'` flags exactly this text (the
# UTF-8 lead byte 0xD1 is shared), so this case is what keeps the guard from being
# quietly re-implemented as a byte match. Also green: Russian in a COMMENT
# (comment-proof by AST construction) and Russian inside an excluded path.
#
# Every case runs the real guard against a fabricated tree via `--root`.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="$GUARD_DIR/check-no-russian-letters.mjs"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

# $1 = case name -> echoes fabricated root with the dirs the guard scans.
new_root() {
  local root="$WS/$1"
  mkdir -p "$root/apps/api/src/finance" \
    "$root/packages/shared/src/i18n/locales/uk" \
    "$root/packages/shared/src/i18n/locales/en"
  printf 'msgid ""\nmsgstr ""\n' >"$root/packages/shared/src/i18n/locales/uk/messages.po"
  printf 'msgid ""\nmsgstr ""\n' >"$root/packages/shared/src/i18n/locales/en/messages.po"
  printf '%s' "$root"
}

run_guard() { node "$GUARD" --root "$1" "${@:2}"; }

# ── fixtures ───────────────────────────────────────────────────────────────────
CLEAN="$(new_root clean)"
printf 'export const ok = "all good";\n' >"$CLEAN/apps/api/src/finance/a.ts"

RU_TS="$(new_root ru-ts)"
printf "const x = 'Кошелёк';\n" >"$RU_TS/apps/api/src/finance/a.ts"

RU_TEMPLATE="$(new_root ru-template)"
# Russian only in the MIDDLE span of a template with substitutions.
printf 'const n = 1;\nconst x = `Баланс ${n} зарплаты ${n} ok`;\n' >"$RU_TEMPLATE/apps/api/src/finance/a.ts"

RU_PO_UK="$(new_root ru-po-uk)"
printf 'msgid "Salary"\nmsgstr "зарплаты"\n' >>"$RU_PO_UK/packages/shared/src/i18n/locales/uk/messages.po"

RU_PO_EN="$(new_root ru-po-en)"
printf 'msgid "Wallet"\nmsgstr "Кошелёк"\n' >>"$RU_PO_EN/packages/shared/src/i18n/locales/en/messages.po"

UA="$(new_root ukrainian)"
cat >"$UA/apps/api/src/finance/a.ts" <<'EOF'
export const a = 'обліковий запис Google, Команда, Київ, зобов\'язання';
export const b = `Баланс користувача ${1} — гривня, їжак, єдиний`;
EOF
printf 'msgid "Account"\nmsgstr "Обліковий запис, Команда, Київ, зобов'"'"'язання"\n' >>"$UA/packages/shared/src/i18n/locales/uk/messages.po"

COMMENT="$(new_root comment)"
cat >"$COMMENT/apps/api/src/finance/a.ts" <<'EOF'
// Кошелёк — русский комментарий разрешён
/* зарплаты, объём, ёлка */
export const ok = 'fine';
EOF

PO_REF="$(new_root po-reference-comment)"
printf '#: apps/web/ыэъё.tsx:1\nmsgid "A"\nmsgstr "B"\n' >>"$PO_REF/packages/shared/src/i18n/locales/uk/messages.po"

EXCL="$(new_root excluded)"
for d in contracts contact resumes job-sourcing assets test database/seed-templates database/seed-fixtures; do
  mkdir -p "$EXCL/apps/api/src/$d"
  printf "export const x = 'Кошелёк';\n" >"$EXCL/apps/api/src/$d/x.ts"
done
mkdir -p "$EXCL/apps/api/src/database"
printf "export const x = 'Кошелёк';\n" >"$EXCL/apps/api/src/database/seed.ts"
printf "export const x = 'Кошелёк';\n" >"$EXCL/apps/api/src/finance/a.spec.ts"
printf "export const x = 'Кошелёк';\n" >"$EXCL/apps/api/src/finance/a.integration.spec.ts"

# Exclusion must be exact: `database/` itself (non-seed) and look-alike dirs are scanned.
NOT_EXCL="$(new_root not-excluded)"
mkdir -p "$NOT_EXCL/apps/api/src/database"
printf "export const x = 'Кошелёк';\n" >"$NOT_EXCL/apps/api/src/database/schema.ts"

echo "== test-check-no-russian-letters.sh =="
echo

# ── negative ───────────────────────────────────────────────────────────────────
assert_red "Russian 'Кошелёк' (ё) in an api string literal -> red" \
  --contains "a.ts:1" --contains "Кошелёк" \
  -- run_guard "$RU_TS"

assert_red "Russian letters in the middle span of a template literal -> red" \
  --contains "a.ts:2" \
  -- run_guard "$RU_TEMPLATE"

assert_red "uk catalog with msgstr \"зарплаты\" (ы) -> red" \
  --contains "uk/messages.po" --contains "зарплаты" \
  -- run_guard "$RU_PO_UK"

assert_red "en catalog with Russian text -> red" \
  --contains "en/messages.po" \
  -- run_guard "$RU_PO_EN"

assert_red "non-seed file under database/ is still scanned -> red" \
  --contains "schema.ts" \
  -- run_guard "$NOT_EXCL"

# ── positive ───────────────────────────────────────────────────────────────────
assert_green "KEY: Ukrainian text (обліковий/Команда/Київ/зобов'язання/їжак) is NOT flagged — no byte-matching" \
  --contains "OK, 0 Russian-letter literals" \
  -- run_guard "$UA"

assert_green "clean tree passes" \
  --contains "OK, 0 Russian-letter literals" \
  -- run_guard "$CLEAN"

assert_green "Russian in // and /* */ comments is NOT flagged (comment-proof)" \
  --contains "OK, 0 Russian-letter literals" \
  -- run_guard "$COMMENT"

assert_green "Russian in a .po '#:' reference line is NOT flagged" \
  --contains "OK, 0 Russian-letter literals" \
  -- run_guard "$PO_REF"

assert_green "Russian in excluded paths (contracts/contact/resumes/job-sourcing/assets/test/seed*/*.spec.ts) is NOT flagged" \
  --contains "OK, 0 Russian-letter literals" \
  -- run_guard "$EXCL"

assert_green "--report prints the violation but exits 0" \
  --contains "Кошелёк" --contains "not failing" \
  -- run_guard "$RU_TS" --report

# ── .claude/hooks: a SECOND scan with a DIFFERENT detector ────────────────────
# The product scan above matches ы э ъ ё only, because the product ships
# Ukrainian and full-Cyrillic matching would flag every "Київ". Under
# `.claude/**` the policy is stricter — everything an agent reads is English,
# comments included — so that scan uses ANY Cyrillic.
#
# WHY THE DETECTOR HAD TO DIFFER RATHER THAN THE PATH LIST BEING WIDENED:
# measured before the choice, of the 258 Cyrillic lines then under .claude/hooks
# the product detector saw only 140 (54%). Reusing it would have let 46% of the
# Russian back in while printing OK. The first red case below is exactly such a
# line — Cyrillic with no ы/э/ъ/ё in it — so if anyone ever "simplifies" the two
# detectors into one, that case goes green and says so.
HOOK_RU="$(new_root hook-ru)"
mkdir -p "$HOOK_RU/.claude/hooks"
printf '#!/bin/bash\necho "команда заблокирована"\n' >"$HOOK_RU/.claude/hooks/pre-bash-new-thing.sh"

HOOK_CMT="$(new_root hook-comment)"
mkdir -p "$HOOK_CMT/.claude/hooks"
printf '#!/bin/bash\n# это комментарий\n' >"$HOOK_CMT/.claude/hooks/pre-bash-new-thing.sh"

HOOK_OK="$(new_root hook-clean)"
mkdir -p "$HOOK_OK/.claude/hooks"
printf '#!/bin/bash\necho "all English here"\n' >"$HOOK_OK/.claude/hooks/pre-bash-new-thing.sh"

HOOK_STALE="$(new_root hook-stale)"
mkdir -p "$HOOK_STALE/.claude/hooks"
printf '#!/bin/bash\necho "English only"\n' >"$HOOK_STALE/.claude/hooks/pre-bash-unbounded-wait.sh"

assert_red "KEY: Cyrillic with NO ы/э/ъ/ё in a new hook -> red (the product detector is blind to this line)" \
  --contains "Cyrillic found in .claude/hooks" \
  --contains "pre-bash-new-thing.sh:2" \
  -- run_guard "$HOOK_RU"

assert_red "Russian in a hook COMMENT -> red (no comment exemption under .claude/**)" \
  --contains "Cyrillic found in .claude/hooks" \
  -- run_guard "$HOOK_CMT"

assert_red "RATCHET: an excepted hook that has become clean -> red, so the list cannot outlive its reason" \
  --contains "AGENT_EXCEPTIONS is stale" \
  --contains "pre-bash-unbounded-wait.sh" \
  -- run_guard "$HOOK_STALE"

assert_green "a clean new hook passes, and the count is reported" \
  --contains ".claude/hooks files scanned" \
  -- run_guard "$HOOK_OK"

assert_green "--report prints the hook violation but exits 0" \
  --contains "Cyrillic found in .claude/hooks" --contains "not failing" \
  -- run_guard "$HOOK_RU" --report

guard_test_summary "test-check-no-russian-letters.sh"
