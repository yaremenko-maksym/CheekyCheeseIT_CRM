# Rule: Orchestration routing — агент vs воркфлоу vs light-track

**Status:** Always-on (энфорсмент **процедурный** — judgment оркестратора, НЕ blocking-хук)
**Applies to:** Master (USER-сессия) и PM — те, кто принимает launch-decision. Агенты-исполнители это дерево не прогоняют.
**Source:** USER-запрос 2026-06-22 (использовать агентов И воркфлоу в связке; оркестратор решает рационально) + аудит агентной архитектуры (workflow `agent-architecture-audit`) + разведка best-practices (Anthropic multi-agent research, Augment Code overkill-rubric, Anthropic cookbook).

---

## Зачем

У проекта УЖЕ есть сильнейший orchestrator-worker — интерактивный PM (Agent tool). Это правило **НЕ** вводит второй оркестратор и **НЕ** переписывает dispatch-логику. Оно добавляет ОДНУ недостающую ось решения — **степень параллелизма**: один агент-pipeline vs параллельная волна vs read-only audit-fanout — и фиксирует, когда параллель оправдана, а когда это over-spawn (multi-agent ≈ 15× токенов чата; ~64% задач один агент ≥ multi-agent при равном контексте).

Две уже существующие оси решения здесь **НЕ дублируются** (их перечитывание = тот самый «третий источник правды», которого избегаем) — они отрабатывают раньше как есть:

- **Cost-of-error** (auth / finance / RBAC / wallets / transactions / Drizzle-миграции / smart-contracts → FULL PIPELINE + **ОБЯЗАТЕЛЬНЫЙ** security-reviewer) — живёт в `pm.md` «Critical-path trigger zones». Срабатывает ПЕРВОЙ и бьёт всё ниже.
- **Тривиальность / обратимость** (docs / cosmetic / ≤30 LOC / 1 файл без бизнес-логики и без security-поверхности → light-track single-pass) — живёт в `light-track.md`.
- **Тир модели** (haiku / sonnet / opus + триггеры эскалации) — ортогонально, `model-routing.md` (тир ≠ трек).

Это дерево прогоняется **после** того как cost-of-error и light-track-гейты отработали как обычно.

## The rule — ось параллелизма (оценивай сверху вниз; первое совпадение выигрывает)

**Предусловие** (не часть этого дерева, отрабатывает раньше — НЕ переписываем):

- задача в critical-path zones (`pm.md`) → FULL PIPELINE + security-reviewer. Ничем ниже не отменяется.
- тривиально / обратимо / docs (`light-track.md`) → LIGHT-TRACK single-pass (Master сам). STOP — воркфлоу/агенты не нужны.

Если задача прошла предусловие и требует кода / работы агентов — выбери ОДНО:

### Решение 1 — один pipeline vs параллельная волна

**Machine-checkable якорь (артефакт, не интуиция):** параллельный fan-out оправдан ТОЛЬКО если PM-декомпозиция дала **≥3 task-файла**, у которых одновременно:

- наборы путей НЕ пересекаются по `zone-of-write` (disjoint files), И
- нет явного `depends_on` / «ждёт вывод другого агента» (нет sequential-зависимости).

→ **все условия ДА** → **WAVE-FANOUT**: PM диспатчит волнами ≤ 3-4 одновременных (`light-track.md` «Потолок concurrency»), стаггер, sweep zombie-портов. Это «agent-оркестрация», НЕ отдельный артефакт.
→ **иначе** → **SINGLE-PIPELINE**: обычный PM Mode 1+2 (sequential coder → review). Большинство задач — здесь («most coding tasks involve fewer truly parallelizable tasks than research» — Anthropic).

Эвристика-помощник, если на грани (5 вопросов Augment Code): независимы? disjoint files? специфицируемо без in-flight вывода другого? нет sequential deps? есть review-bandwidth? Большинство «нет» → single-pipeline. **Решает артефакт (task-файлы); вопросы — только подсказка.**

### Решение 2 — code-work vs read-only breadth-first audit

Если задача — **обзор / аудит ≥3 независимых модулей-контроллеров, материал превышает одно контекст-окно, БЕЗ записи кода** (RBAC-sweep, dead-code, security-поверхность, «как устроено X по всему репо»):

→ **AUDIT-FANOUT** через skill `codebase-audit` (N × haiku explore волнами ≤ 3-4 → opus synth). Движок — Workflow tool ИЛИ `superpowers:dispatching-parallel-agents`. Это ЕДИНСТВЕННЫЙ кейс с реально-новой ценностью поверх интерактивного PM.

### DEFAULT-DENY

Ни одно решение не совпало явно → **SINGLE-PIPELINE / один агент**. Параллельный fan-out запускается ТОЛЬКО по явному совпадению Решения 1-ДА или Решения 2 — никогда «на всякий случай».

### Middle path ПЕРЕД любым fan-out

Неоднозначная-но-ограниченная задача → сначала самый дешёвый тир (`model-routing.md`: haiku разведка / sonnet работа), эскалация на opus только при провале quality-гейта. Снимает 40-70% стоимости без compounding-context налога fan-out. Полный fan-out — только при настоящем breadth (Решение 2).

## Связка агенты + воркфлоу (integration model)

- **PM (Agent tool) — единственный владелец** интерактивного pipeline: декомпозиция, launch-decision (это дерево), мониторинг event→action, aggregate verdict, User Testing, merge-gating. PM — **НАД** воркфлоу, не стадия внутри.
- **Workflow tool / fan-out — узкий инструмент ПОД оркестратором**, оправдан там, где логика predicate-based и есть measurable-новая ценность. По факту это read-only audit / research (этот аудит — живой прецедент). **Dev-pipeline в JS-воркфлоу НЕ кодируем** — он продублировал бы PM (второй исполняемый источник правды, рассинхрон).
- **Детерминированный слой, который уже есть и НЕ трогается:** `auto-merge-on-label.yml` (label → squash) + CI-гейты.

## Энфорсмент и трекинг

- **Процедурный** (judgment оркестратора), по образцу `design-gate.md`: routing — это РЕШЕНИЕ, а не нарушение; blocking-хук дал бы false-negative на легитимных edge-cases.
- **Трекинг — в существующий `pm-state.json` `events[]`** (не новый трекер): additive `routing_decision` — `{ at, type, track: "light-track" | "single-pipeline" | "wave-fanout" | "audit-fanout", reason }`. Прецедент — `*_skipped` / `security_dispatched`. Логировать только нестандартный трек (wave / audit), чтобы не шуметь.
- Startup-burst guard (≥5 `Agent()` одним сообщением → 529 / CPU-starvation) — пока процедурно (конец Решения 1: волны ≤ 3-4). Non-blocking хук-нудж — возможный follow-up, НЕ в этом правиле (флаки-хук рядом с battle-tested подорвал бы доверие ко всей hook-инфре).

## Красные линии (наследует любой fan-out / воркфлоу)

- `merge-approved` + labels — ТОЛЬКО PM/owner по явному «мерджим» владельца (golden rule #1; см. инцидент reviewer-self-merge).
- security-reviewer ОБЯЗАТЕЛЕН на critical-path — это дерево его УСИЛИВАЕТ, не обходит.
- Агенты только `Agent(isolation=worktree)` + post-проверка `git -C <main> status` (recurring MAIN-contamination).
- Concurrency ≤ 3-4 волнами; `DATABASE_URL=` (пустой) при push feature-веток.

## Связанные правила

- `.claude/rules/common/light-track.md` — «тривиально → light-track» + потолок concurrency (ссылаемся, не дублируем).
- `.claude/rules/common/model-routing.md` — тир модели (ортогональная ось) + middle-path эскалация.
- `.claude/agents/contracts.md` §5 — dispatch-матрицы (КАКОЙ агент); это правило — КАКАЯ степень параллелизма.
- `.claude/skills/codebase-audit/SKILL.md` — механика audit-fanout (Решение 2).

## Источники

- USER-запрос 2026-06-22: агенты + воркфлоу в связке + рациональный launch-decision.
- Anthropic «How we built our multi-agent research system» (~15× токенов vs chat; coding mostly not parallelizable; effort-scaling 1 / 2-4 / 10+).
- Augment Code «When Multi-Agent AI Is Overkill» (5-gate independence; ≥3 независимых модуля до parallel).
- Anthropic cookbook «orchestrator-workers» (orchestrator-worker vs fan-out vs routing).
- Аудит агентной архитектуры 2026-06-22 (workflow `agent-architecture-audit`: дизайн + adversarial-критика NEEDS_REVISION → учтены must-fix'ы).
