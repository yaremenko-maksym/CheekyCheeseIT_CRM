# Rule: Zone-of-write contract per agent

**Status:** Always-on (enforced by hook + Reviewer)
**Applies to:** All write-agents (Coder, AutoTest, DevOps, PM, BA, Architect, ui-ux-designer, manual-qa, legal). `code-reviewer` / `security-reviewer` — read-only к коду.
**Source:** Project hard requirement (CLAUDE.md zones + `.claude/agents/architect.md` Zone-of-write) + Phase 2.5 hook activation (`pre-edit-write-zone-of-write.sh` live).

---

## The rule

Каждый агент может писать ТОЛЬКО в свою зону. Reviewer выдаёт `Verdict: BLOCK` на diff где агент перетоптал чужие файлы.

| Агент                 | Может писать                                                                                                                                                                                                                                                                                                | НЕ может                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Coder**             | `apps/api/**`, `apps/web/**`, `apps/landing/**`, `apps/e2e/**`, `packages/**`, `.claude/tasks/<my-task>.progress.md`, `.claude/tasks/<my-task>.blocked.md`                                                                                                                                                  | `scripts/pm/**`, `scripts/devops/**`, `.claude/agents/**`, `docs/business/**`, `.github/workflows/**`, `.claude/hooks/**`, `.claude/settings*.json`, `.gitmessage`, чужие task-файлы |
| **AutoTest**          | **Любой тестовый файл в репозитории**, где бы он ни лежал: `**/*.spec.ts(x)`, `**/*.test.ts(x)`, каталоги `__tests__/`, `__test-helpers__/`, `apps/e2e/**` целиком (включая `fixtures/`), тестовые конфиги (`playwright.config.ts`, `vitest.config.*`), `.claude/tasks/<my-task>.blocked.md`                | **Продуктовый код** — любой не-тестовый файл в `apps/**` / `packages/**`. Также `docs/business/**`, `.claude/agents/**`, `.github/workflows/**`, `scripts/**`                        |
| **DevOps**            | `.github/workflows/`, `docker-compose.yml`, `.env.example`, root `package.json` scripts (`dev:start`, etc.), `scripts/devops/**`                                                                                                                                                                            | `apps/**`, `packages/**`, `docs/business/**`, `.claude/agents/**`, `scripts/pm/**`                                                                                                   |
| **code-reviewer**     | `mcp__github__create_pull_request_review` / inline-comments (read-only к коду)                                                                                                                                                                                                                              | Любые файлы в репо                                                                                                                                                                   |
| **security-reviewer** | `mcp__github__create_pull_request_review` / inline-comments (read-only к коду)                                                                                                                                                                                                                              | Любые файлы в репо                                                                                                                                                                   |
| **copy-reviewer**     | `mcp__github__create_pull_request_review` / inline-comments (read-only к коду)                                                                                                                                                                                                                              | Любые файлы в репо — правки текста вносит автор задачи, не ревьюер                                                                                                                   |
| **PM**                | `.claude/tasks/`, `.claude/state/pm-state.json`, `.claude/briefs/pm-brief-<slug>.md` (update), `docs/business/` (при резолве блокеров), `.claude/agents/memory/<agent>/lessons.md` (append), `scripts/pm/**`                                                                                                | `apps/**`, `packages/**`, `apps/e2e/**`, `.github/workflows/**`, `.claude/agents/<X>.md` (кроме memory)                                                                              |
| **BA**                | `docs/business/`, `.claude/briefs/pm-brief-<slug>.md`                                                                                                                                                                                                                                                       | `.claude/tasks/`, `.github/workflows/`, `apps/**`, `packages/**`, `apps/e2e/**`                                                                                                      |
| **Architect**         | `docs/architecture/**`, `.claude/rules/**`, `.claude/hooks/**`, `.claude/skills/**`, `.claude/agents/<agent>.md` (frontmatter + golden rules + `pm-snippets.md`), `.claude/RULES.md`, `.claude/settings*.json` (регистрация хуков), `scripts/architect/**`, `.github/workflows/**` (additive process-гейты) | `apps/**`, `packages/**`, `docs/business/**`, `.claude/briefs/**`, `.claude/knowledge/legal/**`, `.claude/state/pm-state.json` (PM owns), `.claude/tasks/<чужие активные>` (PM owns) |
| **ui-ux-designer**    | `apps/web/**` + `apps/landing/**` (cosmetic: classNames / tokens / layout / motion), `docs/design/**`, `.claude/tasks/<my-task>.blocked.md`                                                                                                                                                                 | `apps/api/**`, `packages/**`, бизнес-логика в `.tsx`, `.github/workflows/**`, `.claude/agents/**`                                                                                    |
| **manual-qa**         | `apps/web/**` + `apps/landing/**` (ТОЛЬКО cosmetic-фиксы: текст / отступ / класс), `.claude/tasks/<my-task>.blocked.md`                                                                                                                                                                                     | `apps/api/**`, `packages/**`, бизнес-логика, `apps/e2e/**`, `.github/workflows/**`, `.claude/agents/**`                                                                              |
| **legal**             | `.claude/tasks/task-legal-*`, `docs/legal/**`, `.claude/knowledge/legal/**`                                                                                                                                                                                                                                 | `apps/**`, `packages/**`, `.claude/agents/**`, прод-код, `.github/workflows/**`                                                                                                      |

> **Зона AutoTest — по природе файла, а не по каталогу (решение владельца 2026-08-22).** Прежняя
> формулировка отдавала ему только `apps/e2e/**` и **явно запрещала** `apps/api/**`, `apps/web/**`,
> `packages/**` — то есть 452 тестовых файла из 566 были вне его зоны, хотя писать их некому
> больше. Расхождение вскрылось на PR #588, когда интеграционная Vitest-спека под
> `apps/api/src/**` была назначена AutoTest вопреки букве правила (пункт бэклога 165).
> **Граница проходит между тестом и продуктовым кодом, а не между каталогами.** Опасность
> никогда не была в том, что AutoTest правит спеки — она в том, что он правит **продуктовый код**,
> чтобы тест позеленел. Именно это и запрещено.
>
> **Заметки по зонам:** `ui-ux-designer` ↔ `manual-qa` оба пишут cosmetic в `apps/web/**` / `apps/landing/**` — designer по дизайн-spec (Mode B/D conformance/полиш), manual-qa фиксит найденное на live-проходе; разграничение в `contracts.md §5.1/§5.2`. `architect` и `legal` запускаются **USER / Master ad-hoc** (НЕ в авто-PM-dispatch пайплайне) — интенционально (стратегические / по-запросу роли), не пробел.

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

## Architect-specific notes

**Ревизия 2026-08-17 (PR #553, находка CR-L-1).** Прежняя редакция разрешала
Architect'у трогать `.claude/agents/<agent>.md` **только** в рамках ECC-миграции
(добавление frontmatter, skill-таблицы, trimming references), а `.claude/RULES.md`
и `.claude/settings*.json` не упоминала вовсе. ECC-миграция завершилась 2026-06-03 —
и с тех пор правило описывало не то, что происходит. Прецеденты (проверены
`gh pr view` / `git log`, а не по памяти):

- **`.claude/settings*.json` — 4 из 4:** #89, #264, #403, #487, каждый добавлял
  регистрацию хука. Ни один не был отклонён.
- **`.claude/RULES.md`:** #165, #281, #283, #317, #320, #321, #448.
- **Golden rules в агентских доках:** #271 (запрет ревьюерам ставить
  `merge-approved`), #366 (P0 «никаких фоновых ожиданий»), #530, #538 — то есть
  ровно то, что старая формулировка разрешала «только при ECC migration».
- **`pm-snippets.md` + `rules/common/**`:\*\* #403.

Правило разошлось с практикой систематически, во всех четырёх категориях.

Приведено в согласие в пользу практики, а не буквы: **пятнадцать «исключений» —
это норма, которую не записали.** Ровно тот класс дефекта, который этот PR чинит в
рабочих механиках; оставить его в собственных правилах было бы непоследовательно.

Попутно снято внутреннее противоречие: `.claude/hooks/**` стояло в строке
Architect'а **одновременно** в «можно» и в «нельзя» (`legacy, до cleanup`).
Cleanup давно прошёл — колонка «нельзя» вычищена.

Границы новой формулировки:

- **Golden rules и `RULES.md`** — Architect правит, когда меняется межагентная
  механика (новый хук, новое always-on правило, новый обязательный шаг на старте).
  Это не «business logic агента», а контракт среды, в которой агент работает.
- **`.claude/settings*.json`** — зона Architect **по необходимости**: хук,
  который не зарегистрирован, не существует. Писать туда можно **только**
  регистрацию хуков; `permissions`, `enabledPlugins`, `env` — не его.
- **`.github/workflows/**`** — только **additive\*\* процессные гейты. Всё, что
  трогает деплой, сборку или прод-секреты, остаётся DevOps.
- **Architect по-прежнему НЕ переписывает** workflow body / бизнес-логику агента
  (зона PM через `.claude/tasks/`) и НЕ трогает `.claude/state/pm-state.json`
  (PM owns event stream) — он может лишь предлагать новые типы событий.
- **Диффы Architect'а по-прежнему проходят review** — расширение зоны меняет то,
  что не требует `.blocked.md`, а не то, что не требует проверки.

Если правка выходит и за эти границы — `.blocked.md`, как у всех.

**Источник расхождения, чтобы не повторилось.** `.claude/agents/architect.md`
§Zone-of-write **уже** перечислял `.claude/settings*.json (hook registration)` и
golden rules — то есть агентский док был точен, а канонический rule-файл (этот)
отставал. Расходились два описания одной зоны, и агент читает оба. Теперь они
синхронизированы явной пометкой в обоих; **правишь одно — правь второе.**

## Связанные правила

- `.claude/rules/common/git-policy.md` — `git add .` zero-tolerance защищает от accidental cross-zone commits.
- `.claude/rules/common/skills-invocation.md` — какие skills чей зоне.

## Источники

- CLAUDE.md "Multi-Agent команда" + zone hints в каждом agent doc.
- `.claude/agents/architect.md` Zone-of-write section.
- Phase 2.5 deliverable: `docs/architecture/2026-06-03-phase2.5-deliverable.md` (live `pre-edit-write-zone-of-write.sh`).
- ADR `docs/architecture/2026-05-31-ecc-migration-design.md` §2.2.2 (zone-of-write hook).
