# Rule: Design-gate — обязательный дизайнер-в-контуре для любого UI

**Status:** Always-on
**Applies to:** PM (dispatch), Coder, ui-ux-designer, code-reviewer
**Source:** `docs/architecture/2026-06-22-claude-design-integration.md` (§4.7 + §4.8) + утверждено владельцем 2026-06-22 («любое UI-решение должно задействовать дизайнера»).

---

## The rule

**Любая задача, чей diff трогает визуальную поверхность `apps/web/**`или`apps/landing/**`**
(рендеринг `.tsx`, `globals.css`, classNames, layout, иконки, motion) ОБЯЗАНА:

1. **до** того как кодер начнёт верстать — пройти через дизайнера (Claude Design генерация ИЛИ
   ui-ux-designer conformance-проверка), и
2. **после** реализации — пройти fidelity-аудит (ui-ux-designer Mode B).

Интенсивность вовлечения — по tier (ниже). Дизайнер вовлечён ВСЕГДА; вопрос только «насколько».

## Tier-таблица

| Tier  | Триггер                                                  | Действие дизайнера                                                                                                                 |
| ----- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **1** | Новый экран / поток / компонент / редизайн               | Полная генерация в Claude Design (нативный `/design` ИЛИ оркестратор через Chrome MCP) → артефакт → **ui-ux-designer Mode E** spec |
| **2** | Правка существующего экрана                              | Правка существующего дизайна в Claude Design ИЛИ ui-ux-designer conformance-проверка → обновлённый spec                            |
| **3** | Тривиальная косметика (текст, один отступ / цвет токена) | ui-ux-designer conformance-проверка против засинхроненной design-system `CheekyCheeseIT CRM` (без браузерного раунда)              |

- **Tier задаёт PM / оркестратор** при создании задачи — поле `## Design tier:` в task-файле
  (`.claude/tasks/<task>.md`). Если поле отсутствует на UI-задаче — дефолт **Tier 1** (safe).

## Контракт артефакта (единственный интерфейс для headless-кодера)

- `docs/design/<slug>.md` — coder-ready spec (пишет ui-ux-designer Mode E): brief, ссылка на
  Claude Design проект, **token-map** (только наши токены из `globals.css`, не сырой hex),
  список компонентов (существующие shadcn/ui + что новое), motion / a11y (WCAG 2.2) / responsive
  (320/768/1024/1440), edge-cases (empty/loading/error/overflow), путь к референс-скриншотам.
- `docs/design/assets/<slug>/` — `design.html` (экспорт из Claude Design) + `*.png` (скриншоты
  состояний; `design.png` — главный fidelity-референс для Mode B).
- **Headless-кодер видит ТОЛЬКО эти файлы.** Браузер, Claude Design-сессия, Chrome MCP — деталь
  реализации оркестратора, кодеру недоступны. Кодер строит по spec НАШИМИ компонентами/токенами,
  **НЕ копирует сырой экспортированный HTML** (он generic — divs вместо наших компонентов).

## Энфорсмент

- **PM-dispatch гейт:** PM НЕ диспатчит UI-кодера без `docs/design/<slug>.md` (Tier 1/2) или
  записанной Tier-3 conformance-отметки. Dispatch-промпт кодера содержит путь к артефакту +
  «строй нашими shadcn/ui компонентами, соответствуй `design.png`; НЕ вставляй сырой HTML».
  Сниппет — `.claude/agents/pm-snippets.md`.
- **Reviewer-чек:** на PR, трогающем `apps/web/**` / `apps/landing/**` визуальную поверхность,
  code-reviewer проверяет наличие дизайн-артефакта (`docs/design/<slug>.md`) **и** комментария
  fidelity-аудита (Mode B), **покрывающего ВСЕ классы устройств** (`Fidelity: PASS|ISSUES|BLOCK` —
  см. `.claude/rules/common/design-fidelity-review.md`). Отсутствует / частичен (desktop-only) и
  tier ≠ 3 → `Verdict: BLOCK` со ссылкой на правило.
- **`merge-approved` — без изменений:** ставит ТОЛЬКО PM / owner по явному «мерджим» владельца.
  Reviewer / любой агент `merge-approved` НЕ трогает (см. [[feedback_reviewer_self_merge_incident]]).

## Fallback (деградация)

- **Claude Design недоступен / лимит / Chrome MCP-драйв хрупкий** → ui-ux-designer Mode A текстовая
  спека (без браузерного раунда); в PR body отметить `design-gate: degraded` с причиной.
- **Token drift** (`globals.css` изменился, Claude Design отстал) → пере-`/design-sync` перед
  Tier 1 генерацией (детали — `.claude/skills/claude-design-workflow/SKILL.md`).

## Связанные правила

- `.claude/rules/common/zone-of-write.md` — `apps/web/**` = Coder/Designer зона; артефакты в `docs/design/**`.
- `.claude/rules/common/light-track.md` — косметика UI (Tier 3) допустима лёгким треком, но conformance-проверка обязательна.
- `.claude/rules/common/skills-invocation.md` — триггер → `claude-design-workflow` skill.
- `.claude/rules/common/responsive-design.md` — адаптив на 4 классах устройств (hard-гейт); Mode B аудитит ВСЕ классы, генерация запрашивает фреймы для всех.
- `.claude/rules/common/design-fidelity-review.md` — post-impl fidelity-diff макет↔localhost на всех классах = обязательный гейт перед merge (этот файл — гейт ДО кода, fidelity-review — ПОСЛЕ).

## Источники

- ADR / спека: `docs/architecture/2026-06-22-claude-design-integration.md`.
- Implementation-план: `docs/superpowers/plans/2026-06-22-claude-design-integration.md`.
- Память: `project_claude_design_integration`, `feedback_reviewer_self_merge_incident`.
