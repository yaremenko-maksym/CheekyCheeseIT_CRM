# ADR / Design Spec: интеграция Claude Design в агентную фабрику CRM

**Дата:** 2026-06-22
**Статус:** Approved (brainstorm) → pending implementation plan
**Автор:** Master-сессия (PM-оркестратор)
**Связано:** [[ui-ux-designer.md]], `.claude/rules/common/light-track.md`, `.claude/rules/common/zone-of-write.md`, [[feedback_reviewer_self_merge_incident]]

> **UPDATE 2026-06-22 (post-upgrade):** CLI обновлён 2.1.143 → **2.1.185**, который **несёт нативные**
> `/design-login`, `/design-sync`, `/design` (verified в бинаре: design-sync ×262, /design ×67,
> /design-login ×14). Поэтому §4.3/§4.4 «создать проектные команды» **отменены** — опираемся на
> нативные команды; проектная ценность = гейт + Mode E reconciliation + skill + энфорсмент.
> Implementation-план: `docs/superpowers/plans/2026-06-22-claude-design-integration.md`.

---

## 1. Цель

Владелец: «любое UI-решение должно задействовать дизайнера, чтобы он всё расположил
красиво — правильные отступы, грамотный UX». Встроить **Claude Design** (claude.ai/design,
Anthropic Labs, на Opus 4.8) в pipeline так, чтобы:

1. Оркестратор отдавал задачу на дизайн в Claude Design и получал результат.
2. Результат дизайна передавался кодеру **без участия владельца**.
3. Любое изменение в `apps/web` (и `apps/landing`) проходило через дизайн-гейт.

## 2. Жёсткие ограничения (проверено 2026-06-22)

| Факт                                                                                                     | Источник                                                                                                              | Следствие                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Design **интерактивный, браузерный**, research preview, подписка Pro/Max+                         | anthropic.com/news/claude-design-anthropic-labs; живая проверка через Chrome MCP (аккаунт владельца «M», на Opus 4.8) | Драйвить может только человек в браузере ИЛИ оркестратор через Chrome MCP. **Headless-субагент (coder/ui-ux-designer через Agent tool) — НЕ может.** |
| **Нет headless API / MCP-коннектора** к Claude Design                                                    | claude-code-guide recon                                                                                               | Мост кодеру = **файловый артефакт в репозитории**, не live-сессия.                                                                                   |
| Нативных `/design` / `/design-sync` в сборке **нет** (Claude Code v2.1.143, `~/.claude/commands/` пусто) | локальная проверка                                                                                                    | Делаем **проектные** команды-эквиваленты в `.claude/commands/`.                                                                                      |
| Есть раздел **«Design systems»** + «Set up design system» (читает кодбейз → генерит в твоих токенах)     | живая проверка UI                                                                                                     | Высокорычажный фундамент: завести CRM-систему один раз → генерации сразу на-бренд.                                                                   |
| Экспорт: standalone HTML / ZIP / PDF / PPTX; шаблоны Product prototype / wireframe / Blank canvas        | живая проверка UI                                                                                                     | Артефакт = экспортированный HTML + Chrome-MCP скриншот.                                                                                              |

**Вывод:** «дизайнер» в контуре = claude.ai/design, управляемый оркестратором через Chrome MCP.
Передача кодеру — через закоммиченный артефакт-референс, который headless-кодер читает.

## 3. Архитектура (одобрено — Approach 1: design-system-first + artifact handoff + fidelity-аудит)

```
[UI-задача: новый экран / поток / компонент / редизайн / правка]
  │
  (0) design-system CRM в Claude Design уже заведена (разово; поддерживается /design-sync)
  │
  (1) Оркестратор строит design-brief (purpose / audience / tone / token-constraints / edge-cases)
  │       — переиспользует frontend-design-direction 5-вопросов
  (2) Оркестратор → Chrome MCP → claude.ai/design:
  │       design-system = CRM, шаблон = Product prototype/wireframe, вставляет brief → генерация
  │       (рефайн через conversation; владелец может вмешаться для эстетики — fallback §6)
  (3) Экспорт результата В РЕПО  ← SOURCE OF TRUTH:
  │       docs/design/assets/<slug>/design.html      (экспортированный standalone HTML)
  │       docs/design/assets/<slug>/design.png       (+ state-скриншоты: empty/loading/error)
  │       docs/design/<slug>.md                       (brief + Claude Design URL + token-map)
  (4) ui-ux-designer агент (Mode E — reconciliation):
  │       сверяет generic-HTML с нашими shadcn/ui компонентами + Tailwind v4 токенами →
  │       coder-ready spec в docs/design/<slug>.md (какие существующие компоненты, что новое,
  │       token-map, a11y/responsive, edge-cases). НЕ даёт кодеру слепо копировать чужую разметку.
  (5) Диспатч coder: строит в apps/web по spec + HTML-референс + скриншот (наши компоненты/токены)
  (6) ui-ux-designer Mode B (fidelity-аудит): Playwright-скриншот live vs design.png →
          score; BLOCK при дрейфе отступов/иерархии/токенов. Замыкает контур.
```

## 4. Компоненты (well-bounded units)

### 4.1 CRM design system в Claude Design (фундамент, разово + поддержка)

- **Что:** в claude.ai/design → «Set up design system» завести систему «CheekyCheeseIT CRM»
  из `apps/web/app/styles/globals.css` (Tailwind v4 `@theme inline` — цвета/типографика/spacing/radius)
  - инвентаря `apps/web/app/components/ui/` (36 shadcn/ui компонентов).
- **Зачем:** без неё генерация = generic AI-look (purple gradients, oversized hero — то, что
  ui-ux-designer Mode C ловит как AI-slop). С ней — сразу в наших токенах → handoff высокой точности.
- **Зависит от:** Chrome MCP + браузер владельца; доступ к репозиторию (импорт из GitHub или paste токенов).
- **Поддержка:** при изменении токенов — `/design-sync` (§4.4).

### 4.2 Контракт артефакта (интерфейс между дизайнером и кодером)

- `docs/design/<slug>.md` — coder-ready spec (пишет ui-ux-designer Mode E). Содержит: brief,
  ссылку на Claude Design проект, token-map, список компонентов (существующие + новые),
  motion/a11y/responsive, edge-cases, путь к референс-скриншотам. **Расширяет существующую
  конвенцию** (`docs/design/` уже хранит `drop-role-ux.md`, `junior-hub.md` и т.п.).
- `docs/design/assets/<slug>/` — `design.html` (экспорт) + `*.png` (скриншоты состояний).
- **Это единственный интерфейс**, который видит headless-кодер. Всё остальное (браузер,
  Claude Design сессия) — деталь реализации оркестратора.

### 4.3 `/design <бриф>` (проектная команда)

- **Файл:** `.claude/commands/design.md`.
- **Запускает:** ТОЛЬКО главная сессия (нужен Chrome MCP + браузер; headless нельзя).
- **Делает:** шаги (1)→(4) — строит brief, драйвит Claude Design, экспортирует артефакт,
  диспатчит ui-ux-designer Mode E. На выходе — готовый `docs/design/<slug>.md` для кодера.
- **Документирует:** cookbook драйва claude.ai/design через Chrome MCP (см. §4.6 skill).

### 4.4 `/design-sync` (проектная команда)

- **Файл:** `.claude/commands/design-sync.md`.
- **Делает:** (пере)синхронизирует CRM design-system в Claude Design из `globals.css` +
  component-инвентаря. Запускать при изменении дизайн-токенов / добавлении базовых компонентов.
- **Запускает:** главная сессия (браузер).

### 4.5 ui-ux-designer — новый Mode E + усиленный Mode B

- **Mode E (reconciliation, новый):** вход = `docs/design/assets/<slug>/` (Claude Design экспорт).
  Выход = `docs/design/<slug>.md` coder-spec с маппингом на наши компоненты/токены. Headless-агент
  (читает файлы, не браузер). Добавить в `.claude/agents/ui-ux-designer.md`.
- **Mode B (fidelity-аудит, усилен):** теперь сверяет live-реализацию против `design.png`
  референса (а не только 10-dimension эвристики). BLOCK при дрейфе.

### 4.6 Skill `claude-design-workflow` (Chrome MCP cookbook)

- **Файл:** `.claude/skills/claude-design-workflow/SKILL.md`.
- **Зачем:** надёжный драйв claude.ai/design через Chrome MCP — селекторы шаблонов, выбор
  design-system, вставка brief, экспорт HTML, снятие скриншотов состояний, recovery при
  фрагментации UI. Триггерится `/design` и при ручном дизайн-флоу.

### 4.7 Трёхуровневый дизайн-гейт (rule, одобрено)

- **Файл:** `.claude/rules/common/design-gate.md`. **Always-on.** Дизайнер вовлечён ВСЕГДА,
  интенсивность по tier:

| Tier  | Триггер                                              | Действие дизайнера                                                                                      |
| ----- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **1** | Новый экран / поток / компонент / редизайн           | Полная генерация в Claude Design (`/design`) → артефакт → Mode E spec                                   |
| **2** | Правка существующего экрана                          | Правка существующего дизайна в Claude Design ИЛИ ui-ux-designer conformance-проверка → обновлённый spec |
| **3** | Тривиальная косметика (текст, 1 отступ, цвет токена) | ui-ux-designer conformance-проверка против засинхроненной design-system (без браузерного раунда)        |

- **Tier классифицирует** PM/оркестратор при создании задачи (поле `## Design tier:` в task-файле).

### 4.8 Энфорсмент (PM + Reviewer)

- **PM-dispatch гейт:** PM НЕ диспатчит UI-кодера без `docs/design/<slug>.md` (Tier 1/2) или
  conformance-отметки (Tier 3). Сниппет в `.claude/agents/pm-snippets.md`.
- **Reviewer-чек:** на PR, трогающем `apps/web/**` / `apps/landing/**`, code-reviewer проверяет
  наличие дизайн-артефакта и fidelity-аудита; иначе `Verdict: BLOCK`.
- **merge-approved** — без изменений: ставит ТОЛЬКО PM/owner (см. [[feedback_reviewer_self_merge_incident]]).

## 5. Control flow по tier (кратко)

- **Tier 1:** `/design` → (1-4) → PM dispatch coder (5) → Mode B (6) → review → UT → merge-gate.
- **Tier 2:** обновить дизайн (Claude Design edit или conformance) → обновить spec → coder → Mode B.
- **Tier 3:** ui-ux-designer conformance vs design-system → coder/Mode D правка → Playwright-скриншот.

## 6. Failure modes & fallbacks

- **Chrome MCP драйв хрупкий/медленный** (UI Claude Design меняется, селекторы плывут) →
  fallback: оркестратор формирует brief, владелец рефайнит в браузере 1-2 итерации и жмёт Export;
  оркестратор подхватывает артефакт из репо/скриншот и продолжает с шага (3). Skill §4.6 описывает
  обе ветки. Владелец санкционировал автономный драйв, fallback — страховка.
- **design.html generic-разметка** (divs вместо наших компонентов) → именно для этого Mode E (§4.5):
  кодер строит по spec, а не копирует HTML. design.html — визуальный референс, не код для вставки.
- **Token drift** (globals.css изменился, Claude Design отстал) → `/design-sync` перед Tier 1 генерацией.
- **Claude Design недоступен / лимит** → деградация в текущий flow (ui-ux-designer Mode A текстовая
  спека); пометить в PR «design-gate: degraded, Claude Design unavailable».

## 7. Вне scope (YAGNI)

- Двусторонний live-sync кода ↔ дизайна (нет headless API; не строим).
- Автотриггер дизайна в CI/CD (Claude Design интерактивный).
- Кастомный MCP-сервер к Claude Design (нет официального; самописный — отдельная инициатива).
- Замена ui-ux-designer агента — он остаётся (reconciliation + audit), не выпиливается.
- Деплой / public-модуль / прочие открытые треды — не трогаем.

## 8. Открытые вопросы — решены

- Где артефакты → `docs/design/<slug>.md` + `docs/design/assets/<slug>/` (расширяет конвенцию).
- Кто драйвит Claude Design → оркестратор через Chrome MCP (fallback — владелец, §6).
- Scope гейта → буквально любое UI, трёхуровневая интенсивность (§4.7).
- Подписка → Max включает Claude Design (проверено: доступ есть).

## 9. Deliverables (для implementation plan)

1. CRM design-system заведена в Claude Design (§4.1) + pilot-генерация для проверки экспорта.
2. `.claude/rules/common/design-gate.md` (§4.7).
3. `.claude/commands/design.md` + `.claude/commands/design-sync.md` (§4.3/4.4).
4. `.claude/skills/claude-design-workflow/SKILL.md` (§4.6).
5. `.claude/agents/ui-ux-designer.md` — Mode E + усиленный Mode B (§4.5).
6. `.claude/agents/pm-snippets.md` + reviewer-доки — энфорсмент (§4.8).
7. Обновить `.claude/rules/common/skills-invocation.md` (trigger → claude-design-workflow) +
   `CLAUDE.md` карту указателей.
8. Pilot: прогнать одну реальную UI-задачу end-to-end (Tier 1) для валидации pipeline.

**Zone-of-write:** всё в `.claude/**` + `docs/**` — master/architect зона (НЕ apps/packages).
Реализация — преимущественно главной сессией; ADR-обвязку можно через architect-агента.
