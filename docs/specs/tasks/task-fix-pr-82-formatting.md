# task-fix-pr-82-formatting

## Агент: coder

## Приоритет: medium

## Ветка: test/business-logic-e2e-coverage (target_branch — фикс в существующую ветку PR #82)

## Контекст

PR [#82](https://github.com/yaremenko-maksym/CheekyCheeseIT_CRM/pull/82) — AutoTest BG agent's E2E coverage PR ("системное покрытие бизнес-логики"). Завершён ранее, имеет красные CI checks:

1. **`check-formatting`** ❌ — prettier нашёл unformatted файлы → label `hook-bypass-warning` авто-выставлен.
2. **`E2E (finance)`** ❌ — **infra-issue**: Docker Hub registry timeout (`registry-1.docker.io request canceled`) → minio контейнер не запустился. Не test bug, transient. Re-run должен помочь.

Остальные CI checks зелёные: typecheck/lint/unit + 4 из 5 E2E shards (auth-nav, team-users, projects, misc).

## Задача

**Fix только prettier**. После push CI re-trigger автоматически — на retry Docker Hub registry будет доступен и E2E finance shard пройдёт.

## Конкретные изменения

1. `git fetch origin && git checkout test/business-logic-e2e-coverage && git pull` — взять последнюю версию ветки.
2. `pnpm install --frozen-lockfile` — убедиться что `node_modules/.bin/prettier` и `lint-staged` установлены (избежать silent fail как было в PR #83).
3. Получить список PR-changed файлов и прогнать prettier `--write`:
   ```bash
   BASE_SHA=$(git merge-base HEAD origin/main)
   git diff --name-only --diff-filter=ACMR "$BASE_SHA" HEAD \
     | grep -E '\.(ts|tsx|js|jsx|json|md|yml|yaml)$' > /tmp/pr82-files.txt
   xargs -a /tmp/pr82-files.txt pnpm exec prettier --write
   ```
4. Подтвердить локально `prettier --check`:
   ```bash
   xargs -a /tmp/pr82-files.txt pnpm exec prettier --check
   ```
   — должно пройти zero diff.
5. `git add` ТОЛЬКО prettier-fixed файлы (точечно, **НЕ** `git add .` / `git add -A`).
6. Commit с `ac_verified: 1`. Финальный commit без `wip:`.
7. `git push origin test/business-logic-e2e-coverage` (без `--no-verify`).

## Acceptance criteria

- [ ] AC1: `pnpm exec prettier --check` на PR-changed files проходит локально (zero diff)
- [ ] AC2: Commit message содержит `ac_verified: 1`; нет `wip:`
- [ ] AC3: На GitHub после push workflow `Check no hook bypass` зелёный (`gh run list --branch=test/business-logic-e2e-coverage --workflow="Check no hook bypass" --limit=1`)
- [ ] AC4: `E2E (finance)` shard в новом CI run — **SUCCESS** (Docker Hub теперь доступен; если опять FAILURE по transient — PM re-run'нет вручную)

## Запрещено трогать

- Любая логика, **только prettier формат**
- Любые тесты — это уже AutoTest PR, не дополнять spec'ы (это другая ветвь работы)
- `apps/web/**`, `apps/api/**` (НЕ менять, если prettier не предлагает)
- `.github/workflows/**` (DevOps zone)

## Verification (Coder перед `git push`)

1. `git diff HEAD~1 HEAD --shortstat` — только мелкие косметика
2. `git diff HEAD~1 HEAD` — каждая строка whitespace/escape/indent only
3. Commit message формат:

   ```
   fix(format): prettier --write on PR #82 files (resolve check-no-hook-bypass)

   ac_verified: 1
   ```

## Skills required

- `superpowers:using-superpowers` (старт)
- `superpowers:verification-before-completion` (перед push)

## Notes для Coder

- Это **separate PR (не моя Phase 6A feature)**. Просто формат fix, не trigger semantic changes.
- НЕ использовать `--no-verify` (RULES §2.1).
- `E2E (finance)` failure — infra (Docker Hub timeout), не code bug. На retry должно пройти. Если опять fail — PM расследует.
