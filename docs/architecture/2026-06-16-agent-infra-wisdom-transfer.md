# ADR 2026-06-16 — Agent-Infra Wisdom Transfer (leaked Claude Code source)

**Status:** Accepted
**Type:** Architecture / Process hardening
**Author:** Master session (wisdom-transfer dispatch)
**Scope:** `.claude/agents/**`, `.claude/skills/**`, `.claude/rules/common/**`, `docs/architecture/**` (docs-only; no production code)

---

## Context

USER нашёл бэкап утёкшего полного исходника самого Claude Code (слив через npm sourcemap, 2026-03-31),
лежит в `/Users/maksym/Desktop/programming/claude-code/` (вне CRM-репо, read-only). Это эталонные
реализации Anthropic тех систем, которые мы собрали вручную. Принцип wisdom-transfer: **перенимать
battle-tested паттерны, а не изобретать локально**.

Три эталонных файла легли в основу переноса:

| Leak file                                   | Что эталонизирует у нас                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `coordinator/coordinatorMode.ts`            | Системный промпт мультиагентного координатора Anthropic -> наш `pm.md`                             |
| `services/autoDream/consolidationPrompt.ts` | Промпт консолидации памяти -> наша MEMORY.md / lessons система                                     |
| `skills/bundled/skillify.ts`                | Каноническая схема SKILL.md (frontmatter + per-step аннотации) -> наши `.claude/skills/*/SKILL.md` |

---

## Decision — что перенесено (D1–D3)

### D1 — `pm.md` <- coordinator patterns

Добавлена секция **«Coordinator-дисциплина (синтез dispatch)»** (после «Mandatory skill invocation»),
синтезирующая `coordinatorMode.ts` §4–5 под наш стек. 5 принципов:

1. **Синтез — главная работа PM, его нельзя делегировать.** Жёсткий запрет на формулировки
   «разберись по результатам исследования» / «на основе findings агента». PM сам читает находки
   research-агента и пишет спеку с конкретными путями + номерами строк. Anti-pattern vs good пример
   на наших путях (`apps/api/src/finance/finance.controller.ts:88`).
2. **Purpose-statement** в каждом dispatch-промпте (калибровка глубины).
3. Явные фазы **Research(∥) -> Synthesis(PM) -> Implementation -> Verification**, с учётом нашего
   реального потолка concurrency ≈3-4 (см. failure-mode FM-1 ниже).
4. **Verifier смотрит свежими глазами** — отдельный fresh-агент.
5. **Self-contained dispatch-промпты** — агент не видит разговор с USER.

**Harness-ограничение, явно зафиксировано:** continuation воркеров через `SendMessage` в нашем
CLI-harness НЕДОСТУПНА (memory `feedback_no_sendmessage`). Матрицу «continue vs spawn» из
`coordinatorMode.ts` НЕ переносим — у нас всегда fresh spawn. Дисциплина синтеза применима полностью.

### D2 — `.claude/skills/*/SKILL.md` <- skillify schema

Всем 12 скиллам добавлено `when_to_use:` во frontmatter (критичное поле авто-инвокации из
`skillify.ts`: формат «Use when… Examples: '<триггер>'») + `allowed-tools:` (минимальные паттерны
прав). Триггеры извлечены из существующих `description` + таблицы `skills-invocation.md` (источник
истины). Попутно: два `description:` с двоеточиями (`code-review-discipline`, `playwright-patterns`)
закавычены — раньше ломали строгий YAML-парсинг.

**Решение по per-step Success criteria:** skillify требует «Success criteria REQUIRED on every step»
для **линейных пошаговых** воркфлоу. Все наши 12 скиллов — **каталоги паттернов / cookbook'и**
(независимые рецепты «паттерн 1, паттерн 2…»), а не последовательные процессы, где модели нужен сигнал
«когда переходить к следующему шагу». Навешивать Success-criteria на независимые рецепты = bloat,
противоречащий самому skillify («keep simple skills simple»). Поэтому тело скиллов не тронуто —
только frontmatter. Если позже появится истинно-линейный workflow-скилл — он получит per-step критерии.

### D3 — cleanup deprecated/stale

- `architecture-v2.md`, `architect-audit.md`, `CHANGES.md` -> `docs/architecture/archive/`
  (с ARCHIVED-баннерами; работа выполнена, ECC-миграция завершена).
- Удалены **6 thin redirect-стабов** (`CLAUDE-pm/coder/reviewer/autotest/devops/tools.md`, 8–12 строк
  каждый, с баннерами DEPRECATED 2026-06-02). Контент давно живёт в `pm.md`/`coder.md`/`code-reviewer.md`
  - `security-reviewer.md`/`autotest.md`/`devops.md` + `project-state.md`/`RULES.md`. Живые ссылки
    обновлены в `README.md`, `architect.md`, `project-state.md`.
- **Сохранены:** `CLAUDE-legal.md` (135 строк ACTIVE operational notes — durations / knowledge base
  structure, читается из `legal.md` + `pm-snippets.md` 6×; это НЕ stub) и `reviewer.md` (deprecated
  shim, удаление — Phase 6 follow-up).
- Dangling-ссылок в живых файлах (`.claude/agents/*.md` кроме archive, `.claude/rules/**`,
  корневой `CLAUDE.md`) нет (grep-проверка в PR).

---

## Audit — recurring failure modes + контрмеры

Аудит наших повторяющихся классов инцидентов по memory-указателям. Для каждого: **симптом ->
корневая причина -> existующая контрмера -> предлагаемое улучшение**.

### FM-1. Over-параллелизм -> 529-burst / CPU-starvation

- **Симптом:** диспатч 5+ агентов одним сообщением -> часть получает `API Error: 529 Overloaded` и
  умирает на старте (0 tool_uses); тяжёлые Coder'ы + live UT-стек -> load до 47 -> pre-push timeout-флаки
  (`phone-input.test.tsx` 6s->88-309s, `compression.service.spec.ts` 60000ms) — НЕ код, ресурс.
- **Корневая причина:** одновременный startup-burst первых API-вызовов превышает rate-лимит связки
  машина+API; каждый Coder бутит свой vite+api стек + гоняет full Vitest. Источник:
  `session_ops_lessons_2026_06_15`, `project_push_and_stacked_pr_gotchas` §1.
- **Existующая контрмера:** memory-заметки (read-side), но не зафиксировано в правилах.
- **Улучшение:** явный **потолок concurrency ≈3-4** зафиксирован в `pm.md` (Coordinator-секция) +
  `light-track.md` (новый пункт «Параллельный диспатч»): диспатчить волнами по 2-3, стаггерить,
  529-убитых перезапускать (0 работы сделали), перед push — sweep zombie dev-портов
  (`for p in 3010 3011 …; do lsof -ti tcp:$p; done` -> kill, сохранив live :3000/:3001).

### FM-2. MAIN-contamination от worktree-агентов

- **Симптом:** Coder в `isolation=worktree` при ПЕРВОМ Write пишет в MAIN-repo по абсолютному пути;
  RBAC-агент переключал юзерский :3000-стек на feature-ветку. ~5× за сессию (поймано только потому
  что PM проверял).
- **Корневая причина:** агент копирует main-repo-абсолютные пути из codegraph-вывода / из инструкции
  «читай task-файл по /Users/.../CheekyCheeseIT_CRM/...»; хук `block-production-edits.sh` НЕ ловит
  worktree-агента, пишущего в main-repo `apps/**` (infra-gap). Источник:
  `session_ops_lessons_2026_06_15` §2, `feedback_parallel_coder_contamination`,
  `feedback_agent_completion_verification`.
- **Existующая контрмера:** `block-production-edits.sh` (только из main-checkout Coder'а); ручная
  PM-проверка.
- **Улучшение:** в `zone-of-write.md` добавлен MANDATORY-чеклист «верифицируй MAIN чист после каждого
  Coder»: `git -C <main-repo> status --porcelain apps/ packages/` после каждого завершившегося Coder'а;
  в dispatch-промпт Coder'а — явный блок «ВСЕ Edit/Write ВНУТРИ worktree, проверь `git -C <worktree>
status` после первого edit». Ужесточение хука на worktree-кейс — отдельный follow-up.

### FM-3. Flaky-E2E маскировка через retries

- **Симптом:** Playwright E2E интермиттентно красит CI, блокирует merge, не связано с изменением;
  `retries:2` в CI маскирует флаки (зелёный re-run скрывает нестабильность).
- **Корневая причина:** разные классы — (a) click->`toHaveURL` race в hover-reveal opacity-transition;
  (b) **dev/prod build difference**: спека кликала dev-only testid, tree-shaken из prod-билда
  (`import.meta.env.DEV===false`) -> click по отсутствующему элементу; (c) integration concurrency
  (см. FM-4). Источник: `project_e2e_flaky_and_automerge`, memory `feedback_zero_flaky_e2e`.
- **Existующая контрмера:** zero-flaky policy (memory), known flakes пофикшены #163/#216; pre-push
  гоняет тесты локально.
- **Улучшение:** правило в `playwright-patterns` SKILL (now с `when_to_use` авто-инвокацией) — фиксить,
  не маскировать: верифицировать фикс ~10× локально; CI-only фейл => подозревать dev/prod build
  difference, не только timing; guard dev-only testid через `if (await el.isVisible())`. «Зелёный
  re-run» допустим как proof ТОЛЬКО когда изменение причинно не может трогать падающий тест — не как
  привычка.

### FM-4. Integration-test concurrency-флак (shared CI-postgres)

- **Симптом:** `*.integration.spec.ts` интермиттентно красит CI; vitest по умолчанию параллелит ФАЙЛЫ
  в форках против ОДНОЙ shared CI-postgres; спеки, меряющие ГЛОБАЛЬНЫЕ дельты (агрегат без WHERE-скоупа),
  ломаются от вставок соседних спек в окне baseline->assert.
- **Корневая причина:** глобально-скоупные ассерты + параллельные форки + одна БД; vitest 4.1.8 удалил
  `test.poolOptions` -> старый `poolOptions.forks.maxForks` стал silent no-op. Источник:
  `session_ops_lessons_2026_06_15` §3 (пофикшен #216).
- **Existующая контрмера:** `fileParallelism:false` ТОЛЬКО для integration-прогона (детект по argv
  `integration.spec`); unit остаётся параллельным.
- **Улучшение:** инвариант в ADR (и кандидат в `testing`-правило): integration-спеки, делящие БД,
  идут СЕРИЙНО либо скоупят ассерты к своим уникально-маркированным строкам (не глобальные дельты).
  Без DATABASE_URL — graceful-skip (см. FM-6).

### FM-5. Mocked-E2E пропускает global guards (data-leaks)

- **Симптом:** mocked Playwright E2E зелёный, но реальный backend отдаёт 403/200 иначе; РЕЦИДИВ 3×
  (последний 2026-06-09: #157 `getProfile` identity-leak SENIOR'у, #158 `getSummary` finance-leak
  любому залогиненному — реальные OWASP A01 дыры, были и на main).
- **Корневая причина:** mock возвращает то, что разработчик ОЖИДАЕТ, не то что backend реально отдаёт;
  front-only gating (`enabled: isAdmin` = UX, не security) маскируется self-fulfilling моком; reviewers
  смотрят controller-level authz, не global-guard interaction. Источник: `feedback_mocked_e2e_guards`.
- **Existующая контрмера:** security-reviewer обязателен для auth/finance/RBAC; mandatory Manual QA на
  живом стеке; memory-заметки.
- **Улучшение:** усилить как инвариант (уже в `skills-invocation.md` security trigger + `pm.md` Legal
  heuristic): для finance/RBAC/auth путей security-review ОБЯЗАН требовать **реальный backend-тест
  guard'а** (caller без прав -> 403), НЕ mocked-frontend E2E. «E2E мокает endpoint» на security-пути =
  red flag. Зелёный mocked-E2E на таких путях читать как «guard не проверен».

### FM-6. «completed» != done (обрезание агентов)

- **Симптом:** фоновый агент отчитался «completed», но `<result>` = mid-execution строка; тесты написаны
  но не закоммичены, только `wip:` без финального `ac_verified:`, PR не открыт, иногда работал в MAIN.
- **Корневая причина:** turn/session/usage-лимиты режут агента mid-flight; SendMessage-continuation
  недоступна (всегда fresh spawn). Источник: `feedback_agent_completion_verification`,
  `session_ops_lessons_2026_06_11`, `session_ops_lessons_2026_06_15` §6.
- **Existующая контрмера:** wip-push каждые 2 файла / 5 мин (git-policy); RULES §4 recovery-чеклист;
  `dev-flow-resilience` skill (sentinel/intent markers).
- **Улучшение:** verify-чеклист перед «done» зафиксирован как обязательный (RULES §4.2 + `pm.md`
  Coordinator §4 fresh-eyes verifier): `git -C <wt> status --short` (untracked `*.spec.ts`?),
  `git log --oneline origin/main..<branch>` (финальный не-`wip:` с `ac_verified:`?), `gh pr list`,
  `git worktree list` (MAIN не на feature-ветке?). Если не так — финализировать самому или передиспатчить
  свежим агентом в готовый worktree. `dev-flow-resilience` теперь авто-инвокабелен через `when_to_use`.

### FM-7. Stacked-PR rebase после squash-merge

- **Симптом:** squash-merge базовой ветки **ЗАКРЫВАЕТ** (не ретаргетит) стекнутые PR (#200/#201 ->
  CLOSED при мерже #198); ветка, ребейзнутая на main ДО мержа сиблинга, тащит его stale-файлы -> CI красный.
- **Корневая причина:** GitHub не ретаргетит PR при удалении базовой ветки; `git rebase origin/main`
  на стек replay'ит squash-away коммиты базы -> конфликт. Источник: `project_push_and_stacked_pr_gotchas` §2.
- **Existующая контрмера:** memory-рецепт.
- **Улучшение:** инвариант в ADR (кандидат в git-policy follow-up): recovery стекнутой ветки —
  `git rebase --onto origin/main <old-base-SHA> <branch>` (replay только своих коммитов), push с
  `--force-with-lease`, `gh pr create --base main`. Перед мержем реконсилированного стека — ребейзить
  каждую ветку на ТЕКУЩИЙ main (чтобы фикс смердженного сиблинга вошёл).

---

## Targeted rule edits (back-referenced to this ADR)

1. **`.claude/rules/common/light-track.md`** — новый пункт «Параллельный диспатч (потолок concurrency)»:
   ≈3-4 одновременных старта, волны по 2-3, sweep zombie-портов, `DATABASE_URL= git push` (FM-1, FM-6, FM-7).
2. **`.claude/rules/common/zone-of-write.md`** — MANDATORY-пункт «Верифицируй MAIN чист после каждого
   Coder» (`git -C <main-repo> status --porcelain apps/ packages/`) + явный worktree-блок в dispatch-промпт (FM-2).
3. **`.claude/rules/common/git-policy.md`** — пункт про `DATABASE_URL= git push` для feature-веток
   (data-safety: integration-спеки graceful-skip, не бьют live crm_db) (FM-6/FM-7 data-safety).

(Минимум по success-criteria D4 — 2 точечные правки; сделано 3.)

---

## Consequences

- PM получает явную coordinator-mental-model (синтез-дисциплина) поверх существующих Mode 1–5.
- Все 12 скиллов авто-инвокабельны по `when_to_use` (раньше only-`name`/`description`).
- Агентная папка чище: -6 stale-стабов, -3 исторических дока (в архив), нет dangling-ссылок.
- Recurring failure modes документированы с контрмерами -> правила точечно усилены.

## Follow-ups

1. **Удалить `reviewer.md` shim** (Phase 6 follow-up) — после того как все live-доки перестанут на него
   ссылаться как на «deprecated shim до Phase 6» (`pm.md`, `code-reviewer.md`, `RULES.md`). Сейчас оставлен.
2. **Ужесточить `block-production-edits.sh`** на worktree-кейс (агент из worktree пишет в main-repo
   `apps/**`) — текущий infra-gap (FM-2).
3. **Sequential pre-push package runs** (`infra/prepush-cpu-resilience`) — убрать parallel `@crm/*` test
   из `.husky/pre-push`, снижает CPU-starvation timeout-флаки (FM-1).
4. **Кандидат `testing`-правило** для integration-DB-инварианта (серийно / уникально-маркированные строки) (FM-4).
5. **Перенести stacked-PR recovery рецепт** в git-policy при следующем апдейте (FM-7).

## Sources

- Leaked Claude Code source backup, 2026-03-31 (npm sourcemap leak): `coordinator/coordinatorMode.ts`,
  `services/autoDream/consolidationPrompt.ts`, `skills/bundled/skillify.ts`.
- Memory: `session_ops_lessons_2026_06_15`, `session_ops_lessons_2026_06_11`,
  `project_push_and_stacked_pr_gotchas`, `feedback_parallel_coder_contamination`,
  `feedback_agent_completion_verification`, `project_e2e_flaky_and_automerge`, `feedback_mocked_e2e_guards`,
  `feedback_no_sendmessage`.
