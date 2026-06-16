# Rule: Git policy — commit hygiene & forbidden patterns

**Status:** Always-on
**Applies to:** All write-agents (Coder, AutoTest, DevOps), with applicable subset for PM / Architect / Reviewer when they touch git.
**Source:** Project hard requirement (CLAUDE.md + `.clauderules`) + 2026-06-02 RCA on `--no-verify` recurrence + 2026-05-23 dev-flow RCA (D3 = AC verification at push).

---

## Zero-tolerance forbidden patterns

| Запрет                                                           | Почему                                                                                                                              | Альтернатива                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `git push --no-verify`                                           | Обходит pre-push hook, который проверяет `ac_verified:`. Реальные инциденты 2026-06-02: 3× за сессию.                               | Доделать AC → честный commit с `ac_verified:`.                    |
| `git commit -n` / `git commit --no-verify`                       | То же.                                                                                                                              | То же.                                                            |
| `git -c core.hooksPath=/dev/null` (любая форма bypass'а hook'ов) | То же.                                                                                                                              | То же.                                                            |
| `--no-gpg-sign` без явного запроса USER                          | Обходит signing.                                                                                                                    | Спросить USER.                                                    |
| `git add .` / `git add -A` / `git add *` / `git add apps/`       | Подметает чужие debug-артефакты из worktree (PR #22 round4 incident, см. `.claude/agents/memory/coder/lessons.md` 2026-05-20 [P0]). | Только явный список файлов из task-секции «Конкретные изменения». |
| Push в `main` напрямую                                           | Branch protection — только через PR.                                                                                                | PR + label `merge-approved` → CI auto-merge.                      |
| `git push --force` в `main` / `master`                           | Уничтожает историю.                                                                                                                 | На своих ветках `--force-with-lease`, на main — никогда.          |
| `git reset --hard origin/main` без warning                       | Уничтожает локальную работу.                                                                                                        | `git stash` → restore.                                            |
| `gh pr merge --admin`                                            | Обходит branch protection (required checks).                                                                                        | Дождаться зелёных checks → squash через label `merge-approved`.   |

CI hard-блок: `.github/workflows/check-no-skip-hooks.yml` падает на PR если в diff появилась строка `--no-verify`. Reviewer выдаёт `Verdict: BLOCK`. PM не приближается к `merge-approved` label.

## Commit message format

```
<type>(<scope>): <subject>

<optional body>

ac_verified: 1,2,3,4,5        # номера AC из task-файла, разделённые запятой
vision: ✓ /crm/team, /crm/team/$teamId    # ТОЛЬКО для UI задач — затронутые роуты
```

- Если все AC выполнены — перечислить все номера: `ac_verified: 1,2,3,4,5`
- Если часть не сделана — указать сделанные + комментарий: `ac_verified: 1,2,4 (3,5 — blocked, см. .blocked.md)`
- Если задача без UI — `vision:` строку опустить, `ac_verified:` обязательна.

Pre-push hook (`.claude/hooks/coder-pre-push.sh`) блокирует `git push` если последний commit на ветке `feature/*` / `fix/*` / `infra/*` / `test/*` не содержит `ac_verified:`. Не обходить — доделать AC.

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
- Phase 2.5 hook activation: `docs/architecture/2026-06-03-phase2.5-deliverable.md` (live `coder-pre-push.sh`).

## Источники

- CLAUDE.md + `.clauderules`
- `.claude/agents/memory/coder/lessons.md` 2026-05-20 [P0] git-add zero-tolerance
- `.claude/agents/memory/coder/lessons.md` 2026-06-02 [P0] `--no-verify` recurrence
- `docs/architecture/2026-05-23-dev-flow-rca.md` D3 (AC verification gate)
- ADR `docs/architecture/2026-05-31-ecc-migration-design.md` §2.2.3 (pre-push hook).
