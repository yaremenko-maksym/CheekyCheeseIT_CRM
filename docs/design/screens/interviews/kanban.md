# Interviews — Kanban board (Phase 1, hero-поверхность)

> Per-screen artifact (CRM redesign). Coder-ready spec на наших shadcn/ui + токенах. Headless-агенты
> опираются ТОЛЬКО на этот файл + `assets/` (браузер недоступен). Шаблон: `docs/design/screens/_TEMPLATE.md`.
> Направление: `docs/design/foundation.md` · Адаптив: `.claude/rules/common/responsive-design.md` (hard-гейт).
> Программа: `docs/superpowers/specs/2026-06-22-crm-redesign-program.md`.

| Поле               | Значение                                                                         |
| ------------------ | -------------------------------------------------------------------------------- |
| Screen             | Interviews — канбан-доска собеседований (контент внутри нового app-shell)        |
| Route / trigger    | `apps/web/app/routes/_authenticated/interviews/index.tsx` (`InterviewsPage`)     |
| Roles              | ADMIN / HR / SENIOR (видят); JUNIOR — нет доступа; DROP — нет (sidebar скрывает) |
| Claude Design URL  | `<заполнится после генерации>`                                                   |
| Status             | `pending`                                                                        |
| Last synced commit | `04ffd90b` (база = main с Phase 0 app-shell)                                     |

## Fidelity reference

- Захваченный РЕАЛЬНЫЙ экран (функц-референс): `assets/kanban/{default,board-mid-pipeline,board-right-columns}.png`
  (сняты ДО Phase 0 — показывают старый app-shell; **доска-контент** актуален, каркас уже редизайнут в Phase 0).
- `design.png` (после генерации) — fidelity-референс Mode B.

## Реальные блоки (1:1 — НИЧЕГО не добавлять/не удалять; рестайл визуала)

Источник: `index.tsx` + `components/KanbanColumn.tsx` + `constants.ts`.

### A. Управляющая строка (над доской) — `px-6 pt-4`, flex, responsive (`sm:flex-row`)

- **Селектор синьора** (`<select>`, ТОЛЬКО ADMIN при seniors>0 / HR): список синьоров по `displayName`. _(Существующий нативный select — можно привести к нашему `Select`/`SegmentedToggle`? НЕТ: 1:1 — оставить функцию выбора; визуально привести к токенам.)_
- **Ссылка «Профиль»** (при выбранном синьоре → `/profile/$userId`), muted-underline.
- **Кнопка «Новая карточка»** (`Button` size sm, иконка `Plus`) — ADMIN/HR/SENIOR (`canCreate`).

### B. Доска — горизонтальный скролл (`overflow-x-auto`), колонки `items-stretch h-full`, `gap-3 px-6`

- **6 активных колонок** (порядок фиксирован): HR Screen · English · Tech · Final · Client · Offer.
- **Вертикальный разделитель** (`w-px bg-border/60`).
- **3 терминальных колонки:** Нанят (HIRED) · Отказ (REJECTED) · Архив (ARCHIVED).
- Лейблы стадий — `constants.ts` `STAGE_LABELS` (НЕ менять текст).

### C. Колонка (`KanbanColumn`) — фикс-ширина (~176px `w-44`), `h-full`

- **Заголовок:** лейбл стадии + **счётчик** карточек (badge). Текущее: цветной фон/текст per stage.
- **Список карточек** (drop-zone, dnd-kit sortable). Пустая колонка — пустое тело.

### D. Карточка (`InterviewCard` / `InterviewCardStatic`)

- Название компании + **внешняя ссылка** (icon) + имя кандидата (+ доп. мета, если есть в коде — сверить). Draggable; клик → detail-sheet.

### E. Состояния

- **default** (с карточками), **loading** (skeleton-колонки — `index.tsx` isLoading), **пустая колонка**,
  **teamless-SENIOR** (`interviews-teamless-empty-state`: иконка + «У вас нет активной команды» + кнопка «Создать или выбрать команду»),
  **JUNIOR** («Нет доступа к разделу»).

### F. Взаимодействия (поведение 1:1 — НЕ менять логику)

- Drag карточки между колонками (dnd-kit, PointerSensor + KeyboardSensor a11y); терминальные колонки двигает только ADMIN/HR.
- Клик по карточке → `InterviewDetailSheet`. Drag в «Нанят» (ADMIN/HR) → `CreateProjectFromHiredDialog`. Кнопка «Новая карточка» → `CreateInterviewDialog`. _(Модалки — отдельные артефакты Phase 1, после апрува борда.)_

## Design direction (рестайл по `foundation.md` — на апрув владельцу)

- **Дисциплина цвета стадий (КЛЮЧЕВОЕ решение):** текущая доска пёстрая — **9 насыщенных цветов** (blue/purple/amber/orange/cyan/green/emerald/red/gray) на колонку (фон/бордер/бейдж). Foundation: «не пёстрый дашборд», бренд-жёлтый — единственный высокоэнергетичный акцент. **Предложение:** спокойные нейтральные колонки (`bg-card`/`bg-surface` + `border-border`) с **дисциплand ированной** дифференциацией стадии — тонкий акцент (маленькая точка/тонкая верх-полоса/приглушённый бейдж), активные vs терминальные визуально различимы (терминальные — приглушённее). Карточки чистые, читаемые; брендовый жёлтый — на активном/CTA. _Владелец решает на макете: сохранить семантические цвета стадий (приглушив) ИЛИ нейтрализовать в монохром с акцентом._
- Плотность/типографика/отступы — по foundation; счётчики `tabular-nums`.

## Состояния для генерации (артефакт)

default (доска с карточками, ADMIN) · loading (skeleton) · пустая колонка · teamless-SENIOR · **мобайл** (доска на узком экране — h-scroll колонок/свайп) · планшет.

## A11y / responsive

- **A11y (WCAG 2.2):** keyboard drag (есть KeyboardSensor) — сохранить; focus-видимость на карточках/колонках; счётчики/бейджи контраст; `aria` на drag-ручках/кнопках.
- **Responsive (4 класса, `responsive-design.md`):** мобайл (<640) — доска горизонтальный скролл, колонки читаемой ширины, свайп; управляющая строка wrap; тач-таргеты ≥44px (карточки/кнопки). Планшет/ноут/большой — доска как есть, без overflow страницы (скролл внутри доски, не страницы).

## Бриф для генерации (Claude Design, system `CheekyCheeseIT CRM`)

Перерисовать профессионально **канбан-доску собеседований** (контент внутри УЖЕ редизайнутого app-shell —
тёмная operations-консоль, бренд-жёлтый дисциплинированно). Сохранить 1:1 блоки A–F. **НЕ добавлять**
новых колонок/кнопок/фильтров. Менять ТОЛЬКО визуал/иерархию/отступы/плотность + **дисциплину цвета стадий**
(см. выше). Состояния: default/loading/empty/teamless/мобайл. Тон: dense·quiet·scannable. Adaptive на
4 классах устройств. Anti-slop: без 9 кричащих цветов, без карточек-в-карточках.
