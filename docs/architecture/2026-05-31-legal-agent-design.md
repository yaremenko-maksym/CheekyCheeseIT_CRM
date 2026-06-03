# Legal-агент (Юрист) — Design

**Status:** Design approved, awaiting implementation plan
**Date:** 2026-05-31
**Author:** AI Architect (под руководством user)
**Scope:** Phase 0 — infrastructure + integration. Phase 1 (контент knowledge base) — отдельно.

## Контекст

Multi-agent система CRM Cheeky Cheese IT имеет 6 действующих ролей (PM/BA/Coder/AutoTest/Reviewer/DevOps). Не закрытая область — **legal/налоговый/compliance-консалтинг**. Решения по фичам (хранение паспортов в S3, USDT smart-contract выплаты, ФОП-режимы для JUNIORов, NDA с клиентами, GDPR для EU-клиентов) принимаются интуитивно без структурного legal-чека.

**Добавляем 7-го агента — Юриста.** Консультирует по 4 областям:

1. Украина ФОП/налоги
2. IT-договоры с клиентами (outsource/outstaffing, NDA, IP rights)
3. Crypto/USDT регуляция (UA закон про віртуальні активи, AML/KYC)
4. GDPR / data privacy

PM может позвать Юриста по запросу, при изменениях в critical PR-zones, и при валидации новой фичи до декомпозиции. Юрист обязан говорить о рисках и предлагать лучшие решения для бизнеса.

## Принятые решения (brainstorming summary)

| Decision             | Choice                                                                 | Rationale                                                                                              |
| -------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Scope coverage       | All 4 areas (UA ФОП + IT-contracts + USDT + GDPR)                      | Все 4 регулярно всплывают в задачах. Разделение на под-агентов — over-engineering для нашего масштаба. |
| Integration patterns | All 4 (on-demand + auto-PR + pre-feature + strategic)                  | Multi-mode позволяет покрыть и preventive (pre-feature) и detective (PR review) и ad-hoc консультации. |
| Knowledge source     | Static база `docs/legal/` + WebSearch fallback с обязательной цитацией | Static — consistent answers, WebSearch — актуализация. Цитация = anti-галлюцинация guard.              |
| Escalation policy    | Confidence-tagged (HIGH/MED/LOW + LOW обязательно verify с human)      | Не блокирует консультации, но signal'ит shaky advice. Hard refuse zones слишком rigid.                 |
| Architecture         | Local subagent dispatched by PM (Approach 1)                           | Reuses existing `Agent()` pattern. Zero new infra. Strategic mode через PM proxy — overhead ≈ 0.       |

## Архитектура

**Тип:** локальный subagent. Запускается через `Agent(description="Legal: ...", prompt="...")` из PM-сессии. Аналог Reviewer/Coder. **Не GHA workflow.**

**Single prompt с branch logic** по `mode={consult, pr-review, brief-check, strategic}`. Все 4 mode share общую логику (read knowledge base → analyze → structured output). Branch logic минимален (где читать вход, куда писать выход). Это проще maintain чем 4 разных промпта.

## Файловая структура

```
docs/
  agents/
    legal.md                              # системный промпт Юриста (NEW)
    CLAUDE-legal.md                       # operational notes (NEW)
    memory/legal/lessons.md               # накопленные уроки (NEW)
  legal/                                  # knowledge base (NEW root section)
    README.md                             # индекс topic folders
    ua-fop/                               # ФОП 3-я группа, единый налог, валютные операции
    crypto-usdt/                          # UA закон про віртуальні активи, USDT, AML, smart contract disclosure
    gdpr/                                 # personal data categories, processor/controller, breach notification
    it-contracts/                         # NDA templates, services agreement, IP rights clauses
    cross-cutting/
      escalation-zones.md                 # explicit list когда → human юрист (criminal/court/госорганы/конкретные суммы налогов)
      citation-rules.md                   # как Юрист обязан цитировать (формат, mandatory fields)
  specs/
    legal-consultations/                  # persistent log Strategic-mode ответов (NEW)
      README.md                           # индекс + правила naming
    tasks/
      templates/task-legal.md.tpl         # template для task-legal-*.md (NEW)
```

**Phase 0 deliverable:** структура с placeholder контентом в `docs/legal/*/`. Пользователь дополняет фактологией в Phase 1.

**Никаких CLI-скриптов в Phase 0.** Если Strategic mode станет частым — `scripts/legal/ask.sh` добавим позже.

## Data flow по 4 modes

### Mode A — On-demand consultation

1. User или PM формулирует вопрос
2. PM создаёт `docs/specs/tasks/task-legal-<slug>.md` с вопросом + relevant context (ссылки на `docs/business/`)
3. PM: `Agent(description="Legal: <slug>", prompt="Ты — Legal-агент. Прочитай docs/agents/legal.md. mode=consult. Task: docs/specs/tasks/task-legal-<slug>.md")`
4. Legal читает task → читает relevant `docs/legal/<topic>/*.md` → опц. WebSearch (с обязательным цитированием) → append'ит `## Ответ юриста` в task-файл
5. PM читает результат → сообщает User в чате
6. Решение по action — у PM/User. Если Confidence: LOW и решение action-critical — рекомендация эскалации к human-юристу

### Mode B — Auto PR review (critical zones)

1. После Coder создал/обновил PR → PM в Mode 2 параллельно с диспетчем Reviewer проверяет diff
2. **Trigger heuristic:** diff matches любой из паттернов:
   - `apps/api/src/{finance,auth,documents,users}/**`
   - `packages/shared/src/schemas/{auth,finance,users,documents}.ts`
   - Добавление новых полей S3/wallet/passport/personal-data в schema.ts
   - Добавление third-party integrations (новые npm пакеты с network access)
3. Если match → `Agent(Legal, mode=pr-review, pr_number=<N>)` параллельно с Reviewer
4. Legal читает diff через `mcp__github__get_pull_request_files` → читает relevant `docs/legal/` → analyze → **write-then-post pattern** (как Reviewer): сохраняет body в `/tmp/legal-output/pr-<N>-<ts>.md` ДО MCP-вызова (resilience против MCP hang)
5. Legal posts через `mcp__github__create_pull_request_review` с `event: COMMENT`, body первая строка: `Legal Review: <Confidence>` + структурированное тело
6. **Info-only.** Не блокирует merge. PR получает label `legal-noted`. Critical findings → PM эскалирует User отдельно в чате

### Mode C — Pre-feature brief check

1. При получении `docs/specs/pm-brief.md` от BA, PM в Mode 1 Шаг 1 применяет heuristic
2. **Trigger heuristic:** brief упоминает любое из:
   - финансы / payments / transactions / payouts
   - user data storage (passport, wallet, telegram, phone)
   - contracts / NDA / IP / договора
   - crypto / USDT / smart-contract
   - third-party integration (S3, Etherscan, NBU API, новые SaaS)
   - hiring / employment (новые user roles или сценарии работы)
3. Если match → `Agent(Legal, mode=brief-check, brief_file=docs/specs/pm-brief.md)` **до декомпозиции**
4. Legal возвращает структуру (как mode A) с акцентом на recommendations для AC. Пример вывода: «Add encrypted-at-rest требование в storage AC», «GDPR Art.13 — добавить consent flow в registration AC»
5. PM включает Legal-recommendations в task-decomposition (Mode 1 Шаг 2). Recommendations логируются в `pm-state.json.events[]` как `legal_pre_feature_done`

### Mode D — Strategic advisor

1. User в чате: «спроси юриста — можно ли нанять JUNIOR через ФОП 2-ю группу?»
2. PM распознаёт legal-вопрос → создаёт `docs/specs/legal-consultations/YYYY-MM-DD-<slug>.md` с вопросом
3. `Agent(Legal, mode=strategic, consultation_file=docs/specs/legal-consultations/...)`
4. Legal отвечает в файл (та же структура output)
5. PM показывает TL;DR + Confidence + Recommendation User в чате. Полный ответ User читает в файле при желании

**Отличие от Mode A:** Mode A — task-flow связана с конкретной фичей/PR. Mode D — strategic вопрос вне feature-pipeline. Persistent log в `docs/specs/legal-consultations/` для future reference.

## Output format (mandatory структура)

Каждый ответ Legal — обязательная структура, одинаковая для всех 4 modes:

```markdown
## Ответ юриста

**Confidence:** HIGH | MED | LOW
**Mode:** consult | pr-review | brief-check | strategic
**Дата:** YYYY-MM-DD

### TL;DR

1-2 предложения. Прямой ответ на вопрос.

### Анализ

Что говорят законы / регуляции. Конкретные статьи / нормы / прецеденты.
Контекст применимости к нашей ситуации.

### Риски (минимум 1 row — даже «нет существенных» = Low/Low с reason)

| Risk | Severity                       | Probability         | Mitigation     |
| ---- | ------------------------------ | ------------------- | -------------- |
| ...  | Critical / High / Medium / Low | High / Medium / Low | конкретный шаг |

### Рекомендация (best for business)

1. <конкретный шаг 1>
2. <конкретный шаг 2>
3. ...

### Источники

- [Стаття 24 ПКУ](https://zakon.rada.gov.ua/...) — конкретная норма
- `docs/legal/ua-fop/fop-3-group.md` — внутренняя база
- WebSearch: `<url> (дата сбора: YYYY-MM-DD)` — для динамических lookup'ов

### Disclaimer

- **Confidence: LOW** → ОБЯЗАТЕЛЬНО verify с human-юристом ДО action. Эта консультация — preliminary check, не binding advice.
- (HIGH/MED) AI preliminary check. Для критичных решений (суд, споры с госорганами, уголовные риски, налоговые суммы > 100k грн) — escalate к human-юристу.
```

**Hard rule в системном промпте:**

> Запрещено отвечать без цитации источника. Если источника нет → Confidence: LOW + явный flag «based on general principles, not specific statute».

## Confidence policy

| Level    | Когда ставить                                                                               | User action                                               |
| -------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **HIGH** | Static база покрывает с явной статьёй закона, ответ однозначен, нет противоречивой практики | Можно действовать по рекомендации с обычной осторожностью |
| **MED**  | Основа есть в `docs/legal/` или WebSearch, но edge case / интерпретация требует уточнения   | Желательно дополнительная проверка для high-stakes action |
| **LOW**  | Вопрос за пределами базы, WebSearch не дал чёткого источника, противоречивая практика       | **MUST** verify с human-юристом ДО action                 |

## PM integration (точечные правки в существующие файлы)

| Файл                                               | Изменение                                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/agents/pm.md` Mode 1                         | Добавить Шаг 1.5 — Legal touchpoints heuristic check на pm-brief.md. Если match → Mode C dispatch ДО декомпозиции                                 |
| `docs/agents/pm.md` Mode 2                         | Добавить row в таблицу событий: `PR diff matches critical zones → MUST dispatch Legal в pr-review mode (info-only, label legal-noted)`            |
| `docs/agents/pm-snippets.md`                       | Новая секция «Legal — диспатч сниппеты»: 4 Agent template'а (по одному на mode)                                                                   |
| `docs/agents/CLAUDE-pm.md`                         | Legal в таблице durations (~10-15 мин per consultation, MED для PR review с большим diff)                                                         |
| `docs/agents/CLAUDE-pm.md` pm-state.json schema v2 | Добавить event types: `legal_dispatched`, `legal_review_posted`, `legal_pre_feature_done`, `legal_escalated_to_human`                             |
| `.github/labels.yml`                               | Добавить label `legal-noted` (color `0075ca` info-blue, description «Legal review posted — info only, не блокирует merge»)                        |
| `docs/agents/coder.md` Zone-of-write               | Добавить `docs/legal/**` в Coder's off-limits zone (legal знания обновляются через User/PM, не Coder)                                             |
| `docs/agents/reviewer.md`                          | Добавить note: «Legal review (если есть на PR) — info-only, не учитывать как gate. Reviewer фокусируется на code quality, Legal — на legal angle» |

## Anti-scope (что НЕ делаем)

| Не делаем                                             | Причина                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Auto-block merge на legal findings                    | Юрист — info-only. Решение блокировать — у PM/User. AI юрист может ошибиться, hard-block создаёт операционный risk |
| GHA workflow                                          | Все consultations < 1 min для PM. GHA добавит 3-5 мин runner overhead per consultation                             |
| CLI script `scripts/legal/ask.sh` в Phase 0           | YAGNI. Strategic mode через PM proxy — overhead ≈ 0. Добавим если Strategic mode станет частым                     |
| Real-time мониторинг законопроектов                   | Out of scope. WebSearch on-demand per question достаточен                                                          |
| Legal unit/E2E tests                                  | Тесты на AI promp output — не имеют смысла. Validation = user feedback + lessons.md                                |
| Replacement human-юриста                              | Юрист — preliminary check для типичных вопросов. Critical decisions всегда → human                                 |
| Multiple sub-agents (Tax-юрист, IT-юрист, GDPR-юрист) | Over-engineering для нашего масштаба. Single Legal с topic folders в knowledge base достаточно                     |

## Memory + Lessons

`docs/agents/memory/legal/lessons.md` — формат как у других агентов:

```
YYYY-MM-DD [P0|P1|P2] [<task-id>] #topic-tag <конкретный урок>
```

Уроки пишутся PM-ом после:

- Merged PR где Legal был attached в Mode B
- Закрытая консультация в Mode A/D
- Pre-feature check в Mode C где Legal recommendation реально повлияла на decomposition

Примеры что записывать (placeholder для будущих сессий):

- `2026-XX-XX [P0] [task-legal-fop-currency] #ua-fop ФОП 3-я группа лимит USD/EUR оборот 7M грн на 2026 — превышение требует переход на общую систему`
- `2026-XX-XX [P1] [task-legal-passport-s3] #gdpr Хранение паспортов в S3 требует encrypted-at-rest (AWS KMS) + access log + retention policy max 3 года после увольнения`
- `2026-XX-XX [P2] [pr-N-finance] #usdt-aml USDT транзакции > $1000 в день одному получателю — флажок AML check, не блокирует но записать в audit log`

## Phasing

**Phase 0 — Infrastructure (этот design → implementation plan):**

1. Создать `docs/agents/legal.md` (системный промпт) + `CLAUDE-legal.md` (operational notes) + `memory/legal/lessons.md` (пустой с шапкой)
2. Создать `docs/legal/` skeleton:
   - `README.md` — index + правила обновления
   - По одному placeholder file в каждой topic folder (ua-fop, crypto-usdt, gdpr, it-contracts, cross-cutting). Placeholder содержит: scope folder, ссылки на authoritative sources, instruction «User дополняет фактологией в Phase 1»
   - `cross-cutting/escalation-zones.md` — explicit list (это критично для confidence policy)
   - `cross-cutting/citation-rules.md` — format для цитации
3. Создать `docs/specs/tasks/templates/task-legal.md.tpl`
4. Создать `docs/specs/legal-consultations/README.md` (пустая папка с правилами naming)
5. Обновить `pm.md`, `pm-snippets.md`, `CLAUDE-pm.md`, `coder.md`, `reviewer.md` (точечные правки из таблицы выше)
6. Обновить `.github/labels.yml` — добавить `legal-noted`

(Этот файл — design doc + ADR в одном. Отдельный ADR не создаём — все решения зафиксированы здесь, ссылка из CLAUDE.md / pm.md ведёт сюда.)

**Phase 1 — Knowledge seeding + first real consultation (после Phase 0 merged):**

- Полнить `docs/legal/ua-fop/`, `gdpr/`, `crypto-usdt/`, `it-contracts/` фактологией. User feeds или копирует из существующих source'ов
- Первая реальная консультация (любой mode) — calibration ответа против expected
- Tune `escalation-zones.md` based на real experience
- Tune Confidence policy thresholds если ответы слишком cautious / слишком confident

**Phase 2 — Optional extensions (далёкое будущее):**

- `scripts/legal/ask.sh` CLI если Strategic mode частый
- Decision log / audit trail для регуляторного compliance
- Auto-update `docs/legal/` через scheduled WebSearch на changes в законах (опасно — может пропустить или ввести в заблуждение, нужна human review)

## Open questions / known risks

1. **Hallucination risk.** AI юрист может выдумать статью / неправильно интерпретировать норму. Mitigation: hard citation rule, Confidence policy, LOW = must-human-verify, lessons.md tracking промахов.
2. **WebSearch stale results.** WebSearch может вернуть устаревшие данные (закон изменился). Mitigation: Legal обязан указывать дату сбора при WebSearch, и при возможности сравнивать с docs/legal/ (если internal база говорит другое — Confidence: LOW).
3. **Critical zones heuristic точность.** Может пропустить PR с legal touchpoint (false negative) или зря дёргать (false positive). Mitigation: log в pm-state.json `events[]`, после нескольких раундов tune паттерны. Initial heuristic — broad strokes (лучше false positive чем negative).
4. **Strategic mode discovery.** Как User узнает что можно «спросить юриста» в чате? Mitigation: document в CLAUDE.md project memory + первый Strategic запрос demonstrate в onboarding.
5. **Knowledge base maintenance burden.** docs/legal/ актуальность — manual work. Mitigation: явно за пределами Phase 0. Lessons + последующие консультации показывают какие topics реально нужны → не делаем upfront comprehensive seeding.
6. **Legal liability.** Если AI юрист даёт совет и user следует ему — кто отвечает? Mitigation: Disclaimer mandatory в каждом ответе. Project README / docs/legal/README.md явно обозначают «AI preliminary check, не replacement». Это organisational, не technical mitigation.

## References

- `docs/agents/pm.md` — PM workflow (Mode 1-4)
- `docs/agents/reviewer.md` — pattern write-then-post (Mode B заимствует)
- `docs/agents/CLAUDE-pm.md` — pm-state.json schema v2 (расширяем event types)
- `docs/architecture/2026-05-23-dev-flow-rca.md` — context для recovery patterns
- CLAUDE.md (root) — стек, бизнес-правила, агенты overview
