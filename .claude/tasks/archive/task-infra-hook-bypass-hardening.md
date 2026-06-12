# task-infra-hook-bypass-hardening

## Агент: devops

## Приоритет: medium

## Модель: sonnet

## Ветка: infra/hook-bypass-hardening

## Контекст

Лейбл `hook-bypass-warning` срабатывает регулярно по двум структурным причинам (разбор PM 2026-06-12):
(1) lint-staged НЕ покрывает `apps/e2e` — e2e-спеки не форматируются pre-commit'ом, агенты забывают ручной prettier
(3 инцидента за 2 сессии, последний — PR #178 533fbd4); (2) workflow `check-no-skip-hooks.yml` умеет только
ДОБАВЛЯТЬ лейбл — после фикса форматирования он висит до мерджа (PR #176 доехал до мерджа с ним).

## Конкретные изменения

1. **lint-staged покрытие apps/e2e** — найди конфиг lint-staged (root `package.json`, секция lint-staged;
   проверь нет ли отдельного .lintstagedrc). Сейчас TS-паттерны покрывают только apps/web, apps/api,
   packages/shared. Добавь `apps/e2e/**/*.ts` → `prettier --write` (только prettier, БЕЗ eslint — у e2e
   свой lint-цикл в CI). Сверь синтаксис с соседними паттернами.
2. **Авто-снятие лейбла** — `.github/workflows/check-no-skip-hooks.yml`: после успешного prettier-check
   (steps.prettier.outcome == 'success') добавить github-script step: если на PR висит `hook-bypass-warning` —
   снять (`issues.removeLabel`, обернуть в try/catch на 404 «label does not exist»). Permissions
   (`issues: write`, `pull-requests: write`) уже выданы — не расширять. Комментарий в step — зачем снимаем.

## Переиспользование / Regression scope

- Паттерн github-script — в том же файле (step «Flag hook bypass»).
- **Не должно сломаться:** существующее поведение флага (label+comment+exit 1 при failure); lint-staged
  для остальных пакетов (не переупорядочивать); workflow `auto-merge` (не трогать).

## Acceptance criteria

- [ ] 1. В lint-staged есть паттерн для `apps/e2e/**/*.ts` с prettier --write (grep подтверждает).
- [ ] 2. Локальная проверка: испорти форматирование в КОПИИ любого e2e-файла, `git add` её,
     запусти `pnpm exec lint-staged` (или эквивалент dry-run) — файл отформатирован; копию удалить, не коммитить.
- [ ] 3. В workflow добавлен success-path step снятия лейбла с try/catch; YAML валиден
     (`pnpm exec prettier --check .github/workflows/check-no-skip-hooks.yml` + actionlint если есть).
- [ ] 4. PR body: «config/CI-only, E2E run skipped per light-track» + ссылка на этот task-файл.

## Interaction tests

Interaction tests N/A — конфиг/CI без UI.

## Запрещено трогать

- `apps/**` (кроме чтения), `packages/**`, `.claude/**` кроме своего progress-файла.
- Остальные workflows (`auto-merge-pr.yml`, `e2e.yml`, CI) — вне задачи.

## Verification (перед push)

1. `git diff HEAD --name-only` — только root package.json (или .lintstagedrc) + check-no-skip-hooks.yml.
2. AC по grep.
3. Финальный коммит: `ac_verified: 1,2,3,4` (vision: опустить — нет UI).
