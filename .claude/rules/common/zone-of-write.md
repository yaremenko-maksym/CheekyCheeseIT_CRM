# Rule: Zone-of-write contract per agent

**Status:** Always-on (enforced by hook + Reviewer)
**Applies to:** All write-agents (Coder, AutoTest, DevOps, PM, BA, Architect).
**Source:** Project hard requirement (CLAUDE.md zones + `.claude/agents/architect.md` Zone-of-write) + Phase 2.5 hook activation (`pre-edit-write-zone-of-write.sh` live).

---

## The rule

Каждый агент может писать ТОЛЬКО в свою зону. Reviewer выдаёт `Verdict: BLOCK` на diff где агент перетоптал чужие файлы.

| Агент         | Может писать                                                                                                                                                                                          | НЕ может                                                                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Coder**     | `apps/api/**`, `apps/web/**`, `apps/e2e/**`, `packages/**`, `.claude/tasks/<my-task>.progress.md`, `.claude/tasks/<my-task>.blocked.md`                                                               | `scripts/pm/**`, `scripts/devops/**`, `.claude/agents/**`, `docs/business/**`, `.github/workflows/**`, `.claude/hooks/**`, `.claude/hooks/**`, `.claude/settings*.json`, `.gitmessage`, чужие task-файлы |
| **AutoTest**  | `apps/e2e/tests/*.spec.ts`, `apps/e2e/fixtures/`, `apps/e2e/playwright.config.ts`, `.claude/tasks/<my-task>.blocked.md`                                                                               | `apps/api/**`, `apps/web/**`, `packages/**`, `docs/business/**`, `.claude/agents/**`, `.github/workflows/**`                                                                                             |
| **DevOps**    | `.github/workflows/`, `docker-compose.yml`, `.env.example`, root `package.json` scripts (`dev:start`, etc.), `scripts/devops/**`                                                                      | `apps/**`, `packages/**`, `docs/business/**`, `.claude/agents/**`, `scripts/pm/**`                                                                                                                       |
| **Reviewer**  | `mcp__github__create_pull_request_review` (read-only к коду)                                                                                                                                          | Любые файлы в репо                                                                                                                                                                                       |
| **PM**        | `.claude/tasks/`, `.claude/state/pm-state.json`, `.claude/briefs/pm-brief.md` (update), `docs/business/` (при резолве блокеров), `.claude/agents/memory/<agent>/lessons.md` (append), `scripts/pm/**` | `apps/**`, `packages/**`, `apps/e2e/**`, `.github/workflows/**`, `.claude/agents/<X>.md` (кроме memory)                                                                                                  |
| **BA**        | `docs/business/`, `.claude/briefs/pm-brief.md`                                                                                                                                                        | `.claude/tasks/`, `.github/workflows/`, `apps/**`, `packages/**`, `apps/e2e/**`                                                                                                                          |
| **Architect** | `docs/architecture/**`, `.claude/agents/<agent>.md` (frontmatter + golden rules) при ECC migration, `rules/**`, `.claude/hooks/**`, `.claude/skills/**`, `.github/workflows/ecc-*.yml` (additive)     | `apps/**`, `packages/**`, `.claude/state/pm-state.json` (LIVE), `.claude/tasks/<active>` (PM owns), `.claude/hooks/**` (legacy, до cleanup)                                                              |

## Enforcement

### Active hook

`.claude/hooks/pre-edit-write-zone-of-write.sh` (live с Phase 2.5) блокирует Coder из main repo при попытке `Edit` / `Write` / `MultiEdit` / `NotebookEdit` в `apps/**` / `packages/**` если PM не разрешил.

### Worktree caveat

В worktree блокировка снимается — Coder _технически_ может перезаписать что угодно. Но это нарушение zone-of-write → Reviewer выдаст `Verdict: BLOCK`.

### Верифицируй MAIN чист после каждого Coder (MANDATORY)

**Status:** добавлено 2026-06-16 (ADR `docs/architecture/2026-06-16-agent-infra-wisdom-transfer.md` FM-2).

Coder в `isolation=worktree` при первом Write иногда пишет в MAIN-repo по абсолютному пути
(копирует main-repo-пути из codegraph / task-файла). `pre-edit-write-zone-of-write.sh` НЕ ловит этот кейс.
Поэтому PM ОБЯЗАН после КАЖДОГО завершившегося Coder'а проверить, что MAIN-чекаут чист:

```bash
git -C <main-repo> status --porcelain apps/ packages/   # пусто = OK; есть строки = контаминация, откатить
```

В dispatch-промпт Coder'а — явный блок: «ВСЕ Edit/Write ВНУТРИ своего worktree; после первого edit
проверь `git -C <worktree> status`; НЕ писать по main-repo абсолютным путям».

### Если задача требует выйти за зону

1. Создать `<task>.blocked.md` с описанием почему.
2. НЕ делать самовольно.
3. Исключение: PM явно указал в task-файле «обнови `docs/business/modules/<X>.md`» — допустимо.

## Architect-specific notes (для ECC migration)

- Architect может писать `.claude/agents/<agent>.md` ТОЛЬКО для:
  - Добавления YAML frontmatter (Phase 3a–3e).
  - Обновления mandatory skill tables (Phase 4).
  - Trimming references при rules extraction (Phase 5).
- Architect НЕ переписывает business logic / workflow body — это PM's зона через `.claude/tasks/`.
- Architect НЕ трогает `.claude/state/pm-state.json` (PM owns event stream).

## Связанные правила

- `.claude/rules/common/git-policy.md` — `git add .` zero-tolerance защищает от accidental cross-zone commits.
- `.claude/rules/common/skills-invocation.md` — какие skills чей зоне.

## Источники

- CLAUDE.md "Multi-Agent команда" + zone hints в каждом agent doc.
- `.claude/agents/architect.md` Zone-of-write section.
- Phase 2.5 deliverable: `docs/architecture/2026-06-03-phase2.5-deliverable.md` (live `pre-edit-write-zone-of-write.sh`).
- ADR `docs/architecture/2026-05-31-ecc-migration-design.md` §2.2.2 (zone-of-write hook).
