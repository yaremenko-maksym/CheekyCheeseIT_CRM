# Rule: Git policy — commit hygiene & forbidden patterns

**Status:** Always-on
**Applies to:** All write-agents (Coder, AutoTest, DevOps), with applicable subset for PM / Architect / Reviewer when they touch git.
**Source:** Project hard requirement (CLAUDE.md + `.clauderules`) + 2026-06-02 RCA on `--no-verify` recurrence + 2026-05-23 dev-flow RCA (D3 = AC verification at push).

---

## Zero-tolerance patterns — сначала целевое действие, потом запрет

> **Почему в таком порядке (2026-08-22).** Управление через запрет затаскивает запрещённое
> поведение в контекст и делает его **доступнее**: отрицание — слабый модификатор, сильно
> активированный концепт его перебивает. Поэтому первая колонка — то, что **делать**, а запрет
> идёт следом как жёсткий guardrail, а не как единственная формулировка. Прежняя редакция ставила
> «Альтернативу» третьей колонкой, то есть последней из прочитанного. Рецидивы (`--no-verify`
> трижды за сессию 2026-06-02, `git add .` на PR #22) — ровно тот класс, где формулировка могла
> быть частью причины. Источник приёма — `mattpocock/skills`, `writing-for-agents` §Negation.

| Делай так                                                             | Не так                                                           | Почему                                                                                                                              |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Доделать AC → честный commit с `ac_verified:`                         | `git push --no-verify`                                           | Обходит pre-push hook, который проверяет `ac_verified:`. Реальные инциденты 2026-06-02: 3× за сессию.                               |
| То же                                                                 | `git commit -n` / `git commit --no-verify`                       | То же.                                                                                                                              |
| То же                                                                 | `git -c core.hooksPath=/dev/null` (любая форма bypass'а hook'ов) | То же.                                                                                                                              |
| Спросить USER                                                         | `--no-gpg-sign` без явного запроса USER                          | Обходит signing.                                                                                                                    |
| Перечислить файлы явным списком из task-секции «Конкретные изменения» | `git add .` / `git add -A` / `git add *` / `git add apps/`       | Подметает чужие debug-артефакты из worktree (PR #22 round4 incident, см. `.claude/agents/memory/coder/lessons.md` 2026-05-20 [P0]). |
| PR + label `merge-approved` → CI auto-merge                           | Push в `main` напрямую                                           | Branch protection — только через PR.                                                                                                |
| На своих ветках `--force-with-lease`                                  | `git push --force` в `main` / `master`                           | Уничтожает историю.                                                                                                                 |
| `git stash` → restore                                                 | `git reset --hard origin/main` без warning                       | Уничтожает локальную работу.                                                                                                        |
| Дождаться зелёных checks → squash через label `merge-approved`        | `gh pr merge --admin`                                            | Обходит branch protection (required checks).                                                                                        |

CI hard-блок: `.github/workflows/check-no-skip-hooks.yml` падает на PR если в diff появилась строка `--no-verify`. Reviewer выдаёт `Verdict: BLOCK`. PM не приближается к `merge-approved` label.

## Commit message format

```
<type>(<scope>): <subject>

<optional body>

ac_verified: 1,2,3,4,5        # номера AC из task-файла, разделённые запятой
vision: ✓ /team, /team/$teamId    # ТОЛЬКО для UI задач — затронутые роуты
```

- Если все AC выполнены — перечислить все номера: `ac_verified: 1,2,3,4,5`
- Если часть не сделана — указать сделанные + комментарий: `ac_verified: 1,2,4 (3,5 — blocked, см. .blocked.md)`
- Если задача без UI — `vision:` строку опустить, `ac_verified:` обязательна.

Pre-push gate (Claude PreToolUse:Bash hook `.claude/hooks/pre-bash-coder-push-gate.sh`, id `pre:bash:coder-push-gate`) блокирует `git push` если последний commit на ветке `feature/*` / `fix/*` / `infra/*` / `test/*` не содержит `ac_verified:`. Не обходить — доделать AC. Энфорс на harness-уровне (PreToolUse), а не через husky: в свежем `isolation=worktree` worktree husky-хуки молча пропускаются (`.husky/_/` gitignored, генерируется только при `pnpm install`).

## Prettier pre-push gate (формат ловим ДО push)

**Status:** добавлено 2026-06-21 (PR `fix(hooks): enforce prettier on pre-push`).

Claude PreToolUse:Bash hook `.claude/hooks/pre-bash-prettier-gate.sh` (id `pre:bash:prettier-gate`)
блокирует `git push`, если изменённые vs `origin/main` файлы (`ts/tsx/js/jsx/json/md/yml`) не
прошли `prettier --check` — локальное зеркало CI-гейта `check-no-skip-hooks.yml`. Причина: в свежем
worktree pre-commit hook (lint-staged → `prettier --write`) молча пропускается (нет husky/node_modules),
неформатированный код раньше уходил в CI и краснил PR (#259/#261/#263). Hook резолвит prettier
worktree-safe (локальный `.bin` → MAIN-repo `.bin` через git-common-dir → `pnpm exec`); если prettier
недостижим — **fail-loud BLOCK** с инструкцией `pnpm install`, а не silent-skip. При блоке выводит точную
команду фикса `prettier --write <файлы>`.

## WIP commits & chunking

`wip:` префикс — маркер незавершённости. Pre-push hook НЕ требует `ac_verified:` на `wip:` коммитах (только на финальном).

- **`wip:` push после каждых 2 файлов** ИЛИ
- **`wip:` push после каждых 5 минут** ИЛИ
- **`wip:` push перед любой операцией > 1 мин** (билд, тесты, миграция)

Финальный коммит — без `wip:`, с `ac_verified:`.

## Push feature-веток: `DATABASE_URL=` пустой (data-safety)

**Status:** добавлено 2026-06-16 (ADR `docs/architecture/2026-06-16-agent-infra-wisdom-transfer.md` FM-6/FM-7).

ВСЕГДА пушить локальные feature-ветки как `DATABASE_URL= git push` (переменная пустая).
Pre-push hook гоняет тесты; без скоупа integration-спеки коннектятся в libpq-дефолт (живая `crm_db`!)
и могут (а) упасть на отсутствующей QA-фикстуре, (б) теоретически тронуть UT-данные USER'а, (в) словить
CPU-timeout под нагрузкой. Пустой `DATABASE_URL` -> integration-спеки graceful-skip, push безопасен.

## Conventional commits scopes (для проекта)

Стандартные: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`. Project-scopes: `(api)`, `(web)`, `(shared)`, `(coder)`, `(architect)`, `(pm)`, `(devops)`, `(autotest)`, `(legal)`, `(reviewer)`. Commit message body — на английском (Conventional Commits standard). User-facing assistant ответы — на русском (см. `.claude/rules/common/russian-language.md`).

## Связанные правила

- `.claude/rules/common/zone-of-write.md` — какой агент может писать какие пути (Reviewer выдаёт BLOCK на нарушения).
- `.claude/rules/common/russian-language.md` — assistant outputs русский, commits английский.
- Phase 2.5 hook activation: `docs/architecture/2026-06-03-phase2.5-deliverable.md` (live `pre-bash-coder-push-gate.sh`).

## Источники

- CLAUDE.md + `.clauderules`
- `.claude/agents/memory/coder/lessons.md` 2026-05-20 [P0] git-add zero-tolerance
- `.claude/agents/memory/coder/lessons.md` 2026-06-02 [P0] `--no-verify` recurrence
- `docs/architecture/2026-05-23-dev-flow-rca.md` D3 (AC verification gate)
- ADR `docs/architecture/2026-05-31-ecc-migration-design.md` §2.2.3 (pre-push hook).
