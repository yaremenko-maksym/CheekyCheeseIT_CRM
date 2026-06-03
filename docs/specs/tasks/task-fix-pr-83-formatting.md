# task-fix-pr-83-formatting

## Агент: coder

## Приоритет: high

## Зависит от: task-onboarding-6a-data-backend (PR #83 уже открыт)

## Ветка: feature/onboarding-data-backend (target_branch — фикс в существующую ветку)

## Контекст

PR [#83](https://github.com/yaremenko-maksym/CheekyCheeseIT_CRM/pull/83) — Phase 6A backend — open. Все CI зелёные **кроме** `check-formatting` (workflow `Check no hook bypass`, run [26864162708](https://github.com/yaremenko-maksym/CheekyCheeseIT_CRM/actions/runs/26864162708)). Label `hook-bypass-warning` авто-выставлен.

Причина: `prettier --check` нашёл unformatted файлы среди PR-измененных. Likely root cause — `lint-staged` silent-fail в worktree (отсутствовал `node_modules/.bin/lint-staged`, аналогично PM-сессии перед install). НЕ обязательно `--no-verify` use.

## Конкретные изменения

1. `git fetch origin && git checkout feature/onboarding-data-backend && git pull` — взять последнюю версию ветки.
2. `pnpm install --frozen-lockfile` — убедиться что dev tools (`lint-staged`, `prettier`) реально установлены.
3. Получить список PR-changed файлов и прогнать prettier на них:
   ```bash
   BASE_SHA=$(git merge-base HEAD origin/main)
   git diff --name-only --diff-filter=ACMR "$BASE_SHA" HEAD \
     | grep -E '\.(ts|tsx|js|jsx|json|md|yml|yaml)$' > /tmp/pr-files.txt
   xargs -a /tmp/pr-files.txt pnpm exec prettier --write
   ```
4. Подтвердить локально через `prettier --check`:
   ```bash
   xargs -a /tmp/pr-files.txt pnpm exec prettier --check
   ```
   — должно пройти zero diff.
5. `git add -- $(cat /tmp/pr-files.txt | tr '\n' ' ')` — стейджить ТОЛЬКО prettier-fixed файлы. **НЕ использовать `git add .` / `git add -A`** (RULES §2.1).
6. Commit с `ac_verified:` (нет AC для fix-task в обычном смысле — указать `ac_verified: 1 (prettier --check passes)` или равноценное).
7. `git push origin feature/onboarding-data-backend` (без `--no-verify`).

## Acceptance criteria

- [ ] AC1: `pnpm exec prettier --check` на PR-changed files проходит локально (zero diff)
- [ ] AC2: Commit message содержит `ac_verified: 1` (или эквивалент); НЕТ `wip:` префикса в финальном commit
- [ ] AC3: На GitHub после push — workflow `Check no hook bypass` зелёный (`gh run list --workflow="Check no hook bypass" --branch=feature/onboarding-data-backend --limit=1`)
- [ ] AC4: Label `hook-bypass-warning` снят (PM сам снимет после verify; либо comment-out, AC verified в момент push)

## Interaction tests

Interaction tests N/A — pure formatting fix.

## Запрещено трогать

- Любая логика, любые тесты — **только prettier-formatting** диф
- Семантические изменения кода — если prettier предлагает не-косметическое — это разрыв формат-правил, нужен новый task
- `apps/web/**` — не входит в Phase 6A
- `apps/e2e/**` — AutoTest zone
- `.github/workflows/**` — DevOps zone

## Verification (Coder перед `git push`)

1. `git diff HEAD~1 HEAD --shortstat` — только небольшое количество строк изменено (формат-косметика)
2. `git diff HEAD~1 HEAD` — каждая строка либо whitespace/indent либо линейный перенос. Никакой логики.
3. Commit message формат:

   ```
   fix(format): prettier --write on PR-changed files (resolve check-no-hook-bypass)

   ac_verified: 1
   ```

## Skills required

- `superpowers:using-superpowers` (старт сессии)
- `superpowers:verification-before-completion` (перед push)

Никакой `writing-plans` или `test-driven-development` — задача чисто механическая (cosmetic format).

## Notes для Coder

- НЕ запускай pnpm install в main repo dir / parent dirs — только в **isolation worktree** где работаешь.
- НЕ trigger Phase 6A logic / тесты — они уже passed, не риск регрессии.
- Если prettier предлагает изменения которые выглядят НЕкосметически — STOP, создай `task-fix-pr-83-formatting.blocked.md` с примером.
