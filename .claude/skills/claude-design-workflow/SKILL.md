---
name: claude-design-workflow
description: 'When оркестратор (Master / PM) или ui-ux-designer драйвит Claude Design (claude.ai/design) для UI-задачи: синхронизация дизайн-системы, генерация экрана, экспорт артефакта-моста для headless-кодера, handoff. Cookbook поверх нативных команд /design-* (CLI ≥ 2.1.185) + Chrome MCP драйв + fallback на владельца.'
when_to_use: "Use when the orchestrator (Master/PM) or ui-ux-designer needs to drive Claude Design for a UI task or produce the handoff artifact (design-gate Tier 1/2). Examples: 'сгенерь дизайн экрана в Claude Design', 'засинкай дизайн-систему', 'экспортируй артефакт для кодера', 'погнали дизайн HR-дашборда', 'нужен design.html + design.png для PR', 'как драйвить claude.ai/design через Chrome MCP'."
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - DesignSync
  - mcp__Claude_in_Chrome__navigate
  - mcp__Claude_in_Chrome__tabs_context_mcp
  - mcp__Claude_in_Chrome__read_page
  - mcp__Claude_in_Chrome__computer
  - mcp__Claude_in_Chrome__browser_batch
  - mcp__Claude_in_Chrome__find
  - Agent
---

# Claude Design Workflow (CRM)

Cookbook драйва **Claude Design** (claude.ai/design, Anthropic Labs, на Opus 4.8) как дизайнера-в-контуре.
Реализует pipeline из `.claude/rules/common/design-gate.md` + ADR `docs/architecture/2026-06-22-claude-design-integration.md`.

**Жёсткое ограничение:** Claude Design интерактивный/браузерный, **headless API/MCP-коннектора НЕТ**.
Драйвит либо оркестратор через Chrome MCP, либо владелец в браузере. Headless-субагент (coder /
ui-ux-designer через `Agent`) сам рисовать НЕ может — он читает **файловый артефакт** в репо.

## When to invoke

- Перед Tier 1/2 UI-задачей (design-gate) — нужна генерация дизайна.
- Когда меняются дизайн-токены (`globals.css`) или базовые компоненты — пере-sync дизайн-системы.
- Когда нужно произвести handoff-артефакт (`docs/design/<slug>.md` + `assets/<slug>/`) для кодера.

---

## 0. Нативные команды (CLI ≥ 2.1.185) — кто и как запускает

CLI 2.1.185 несёт нативные слэш-команды. Они **интерактивные** — их **НАБИРАЕТ владелец** в живой
`claude`-сессии; headless-оркестратор их через Skill-tool НЕ инвоукает.

| Команда         | Что делает                                                                              | Кто набирает         |
| --------------- | -------------------------------------------------------------------------------------- | -------------------- |
| `/design-login` | Привязывает Claude Code ↔ Claude Design (OAuth design-scope к claude.ai-логину)         | Владелец, в `claude` |
| `/design-sync`  | Читает токены + React-компоненты из кода → создаёт/обновляет дизайн-систему в Claude Design («BEST FIDELITY») | Владелец, в `claude` |
| `/design`       | Launch / handoff: генерация под дизайн-систему                                          | Владелец, в `claude` |

**НЕ создавать проектные команды-эквиваленты** (`.claude/commands/design*.md`) — они затенят/сконфликтуют
с нативными. Проектная ценность = гейт + Mode E reconciliation + этот skill + энфорсмент.

### Программный путь sync (когда у сессии есть design-scope)

В сессии есть низкоуровневый tool **`DesignSync`** (`list_projects` / `get_project` / `list_files` /
`create_project` / `finalize_plan` / `write_files` …) — это тот самый мост, который использует нативный
`/design-sync`. НО:

> **Gotcha (проверено 2026-06-22):** если оркестратор-сессия авторизована через `CLAUDE_CODE_OAUTH_TOKEN`
> (env-инъекция), claude.ai **отказывается расширять её design-скоупами** → `DesignSync` падает с
> «Run /login in this session». Программный sync из такой сессии невозможен.
>
> **Решение:** sync делает владелец нативным `/design-sync` в **свежем** `claude` (своя OAuth, не
> token-инъекция), ИЛИ владелец делает `/login` в текущей сессии (риск: рвёт token-auth) → тогда
> `DesignSync` оживает и оркестратор может sync/verify программно.

После любого sync: дизайн-система **`CheekyCheeseIT CRM`** (имя — single source, см. спеку § «Synced
design systems»). Все `/design`-генерации идут под неё → на-бренд, не generic AI-look.

---

## 1. Per-feature генерация через Chrome MCP (автономный драйв)

Когда нужно сгенерить экран без владельца — оркестратор драйвит браузер.

1. **Свой MCP-таб:** `tabs_context_mcp` → получить/создать таб; работать только в нём (не трогать
   живые вкладки владельца).
2. **Навигация:** `navigate` → `https://claude.ai/design`.
3. **Состояние перед кликом:** `read_page` с `filter: interactive` — увидеть реальные кнопки/инпуты ПЕРЕД
   действием (UI Claude Design — Beta, селекторы плывут; не кликать вслепую).
4. **Дизайн-система:** выбрать `Design system = CheekyCheeseIT CRM` (иначе generic-генерация).
5. **Шаблон:** Product prototype (экран/поток) или Wireframe (низкая детализация). Blank — редко.
6. **Brief:** вставить design-brief (переиспользуй `frontend-design-direction` 5 вопросов: purpose /
   audience / tone=`dense/quiet/scannable` / memorable detail / constraints=Tailwind v4 + shadcn/ui +
   Russian UI + WCAG 2.2 AA + responsive 320-1440 + edge-cases).
7. **Генерация → рефайн:** через conversation. Многошаговые действия — `browser_batch` (navigate →
   click → type → screenshot в одном round-trip). После каждого шага — скриншот для подтверждения.

---

## 2. Экспорт артефакта (мост к headless-кодеру) — SOURCE OF TRUTH

Артефакт — **единственный** интерфейс, который видит кодер. Кладётся в репо (`docs/design/**` = зона мастера/дизайнера).

1. **HTML:** в Claude Design Export → standalone HTML → сохранить в
   `docs/design/assets/<slug>/design.html`.
2. **Скриншоты состояний:** Chrome-MCP `computer action:screenshot save_to_disk:true` для каждого
   состояния (default / empty / loading / error) → `docs/design/assets/<slug>/*.png`. Главный кадр —
   `design.png` (fidelity-референс для ui-ux-designer Mode B).
3. **Brief-файл:** написать `docs/design/<slug>.md` — brief + URL проекта Claude Design + предварительный
   token-map. (Полный coder-spec допишет ui-ux-designer Mode E — шаг 3 ниже.)

**Slug** — kebab-case по экрану (`hr-dashboard`, `senior-payouts`). Один slug = одна папка assets.

---

## 3. Handoff → ui-ux-designer Mode E → coder

1. Диспатч **ui-ux-designer Mode E** (`Agent subagent_type=ui-ux-designer`): вход = `docs/design/assets/<slug>/`,
   выход = coder-ready `docs/design/<slug>.md` (маппинг на наши shadcn/ui + token-map + a11y/responsive/
   edge-cases). См. `ui-ux-designer.md` Mode E. **Кодер строит по spec, НЕ копирует сырой `design.html`.**
2. PM диспатчит coder с путём к артефакту (см. `pm-snippets.md` design-gate dispatch).
3. После реализации — ui-ux-designer **Mode B** fidelity-аудит (live Playwright vs `design.png`), затем
   code-reviewer (проверяет наличие артефакта), затем User Testing → merge-гейт (`merge-approved` —
   только PM/owner).

---

## 4. Fallback (деградация) — страховка

- **Chrome MCP-драйв хрупкий / медленный** (UI Claude Design меняется) → оркестратор формирует brief,
  **владелец** рефайнит в браузере 1-2 итерации и жмёт Export; оркестратор подхватывает артефакт из
  `docs/design/assets/<slug>/` и продолжает с шага 2. Владелец санкционировал автономный драйв; fallback — страховка.
- **Claude Design недоступен / лимит** → ui-ux-designer Mode A текстовая спека (без браузера); в PR body
  пометить `design-gate: degraded`.
- **Generic-разметка в экспорте** (divs/hex вместо наших компонентов) → это ожидаемо; именно для этого
  Mode E. `design.html` — визуальный референс, НЕ код для вставки.
- **Token drift** (`globals.css` ушёл вперёд) → пере-`/design-sync` перед генерацией.

---

## Anti-patterns

- **Кодер копирует сырой `design.html`** → теряются наши компоненты/токены. Всегда через Mode E spec.
- **Генерация без `Design system = CheekyCheeseIT CRM`** → AI-slop (purple-gradients, oversized hero).
- **Проектные команды `.claude/commands/design*.md`** → конфликт с нативными; не создавать.
- **Клик вслепую без `read_page`/скриншота** → ломается на дрейфе Beta-UI Claude Design.
- **Sync из token-инъектированной сессии без `/login`** → `DesignSync` падает; делать в свежей сессии.

## Связанные

- `.claude/rules/common/design-gate.md` — 3-tier гейт + контракт артефакта + энфорсмент.
- `.claude/agents/ui-ux-designer.md` — Mode E (reconciliation) + Mode B (fidelity-аудит).
- `.claude/agents/pm-snippets.md` — design-gate dispatch (PM не диспатчит UI-кодера без артефакта).
- ADR: `docs/architecture/2026-06-22-claude-design-integration.md`.
