# Rule: Design-fidelity review — макет ↔ localhost diff на ВСЕХ экранах (mandatory gate)

**Status:** Always-on (hard-гейт; reviewer-enforced + PM-aggregate)
**Applies to:** ui-ux-designer (исполнитель Mode B), PM (aggregate/dispatch), code-reviewer (проверка наличия+покрытия), manual-qa (живое поведение), оркестратор/Master
**Source:** Запрос владельца 2026-06-23 — «в тест-пайплайн добавить ревьюера, который сравнивает макет и localhost на различия и на разных экранах» + «дизайн делать сразу под все экраны». Цель программы редизайна: **дизайн = UI source of truth**.

---

## The rule

После реализации ЛЮБОГО UI (diff трогает визуальную поверхность `apps/web/**` или `apps/landing/**`) и
ДО merge — **ОБЯЗАТЕЛЕН fidelity-diff ревью**: сравнение **дизайн-референса** (макет Claude Design /
`design.png` / spec `docs/design/<slug>.md`) с **живым localhost** на ВСЕХ классах устройств. Расхождение
ИЛИ неполное покрытие классов = `Fidelity: BLOCK` → merge запрещён, пока не устранено.

Это закрывает петлю «дизайн → код»: гарантирует, что реализованный экран следует утверждённому макету на
КАЖДОМ устройстве, а не «примерно похоже на десктопе». Без этого гейта дизайн не может быть source of truth.

## Тест-ширины (классы устройств)

`320 · 375` (мобайл) · `768` (планшет) · `1024 · 1280` (ноут) · `1440 · 1920` (большой). Соответствуют
`responsive-design.md`. Fidelity-diff прогоняется на каждой; «desktop-only проверка» = неполный аудит = BLOCK.

## Кто и что делает

- **Исполнитель — `ui-ux-designer` (Mode B, fidelity-diff).** Грузит дизайн-референс + открывает localhost
  в Playwright, прогоняет тест-ширины, на каждой сравнивает **expected (макет) ↔ actual (localhost)**:
  layout, spacing-ритм, типографика, токены, иерархия, обрезание/overflow, поведение брейкпоинтов,
  тач-таргеты (≥44px на мобайле). Постит в PR per-breakpoint diff-таблицу
  `[Ширина | Компонент | Ожидалось | По факту | Severity]` + скриншоты состояний.
- **Вердикт (вторая строка PR-комментария Designer, после `Design Review:`):** `Fidelity: PASS | ISSUES | BLOCK`.
  - `PASS` — совпадает на всех классах (мелкие нюансы в допуске).
  - `ISSUES` — найдены расхождения → fix перед merge (по строгости = код-BLOCK).
  - `BLOCK` — заметный дрейф / класс не покрыт / референса нет там, где он должен быть.
- **PM (aggregate).** Для UI-PR fidelity-вердикт — ОБЯЗАТЕЛЬНАЯ часть `designer_review_done`
  (`{ visual_verdict, fidelity_verdict, fidelity_issues }`). Нет fidelity-комментария с покрытием всех
  классов → aggregate НЕПОЛНЫЙ, вернуть designer на дорасследование (как Manual QA без design-рубрики).
  `Fidelity: ISSUES|BLOCK` → `do-not-merge` + fix-task кодеру.
- **`code-reviewer`.** Проверяет, что fidelity-комментарий есть И покрывает ВСЕ классы (не desktop-only).
  Отсутствует/частичен на UI-PR (tier ≠ 3) → `Verdict: BLOCK` со ссылкой на это правило.
- **`manual-qa`.** Проверяет реальное ПОВЕДЕНИЕ на мобайл/десктоп (живой проход) — дополняет fidelity-diff
  (designer = соответствие макету; manual-qa = работоспособность/RBAC/консоль).

## Дизайн делается сразу под ВСЕ классы (precondition — обязательно)

Fidelity-diff невозможен без макетов на все классы. Поэтому (усиливает `responsive-design.md`):

- **Генерация (Claude Design):** бриф ОБЯЗАН требовать фреймы для 4 классов (320 мобайл · 768 планшет ·
  1024 ноут · 1440 большой) + состояния (default/empty/loading/error) на каждом — НЕ «десктоп, потом
  адаптив». После генерации проверить, что мобильный фрейм реально присутствует; нет → дорисовать перед
  handoff. Десктоп-only макет на UI-задаче = нарушение правила.
- **Spec (`ui-ux-designer` Mode E):** `docs/design/<slug>.md` описывает responsive-поведение per класс
  (что схлопывается / скроллится / реформатируется).
- **`design.png`:** экспортируется минимум для мобайла (320) И десктопа (1440) как fidelity-референсы Mode B.

## Деградация (fallback)

- **Чистого `design.png` нет** (CD дрейфил / Tier 3) → fidelity-diff против spec `docs/design/<slug>.md` +
  `foundation.md`; в PR body отметить `fidelity: degraded` с причиной. **Responsive-проверка всех классов
  на localhost остаётся обязательной** (overflow / обрезание / тач-таргеты) — деградирует только «эталон»,
  НЕ покрытие устройств.
- **В артефакте только десктоп-макет** → минимум `320 + 1440` сравнение + эскалация PM (Tier 3 degradation).

## Связанные правила

- `.claude/rules/common/design-gate.md` — дизайнер-в-контуре ДО (генерация/conformance) и ПОСЛЕ (этот fidelity-аудит); reviewer-чек ссылается сюда.
- `.claude/rules/common/responsive-design.md` — 4 класса устройств (это правило — приёмка соответствия макету на них).
- `.claude/rules/common/zone-of-write.md` — `ui-ux-designer` / `manual-qa` cosmetic-fix зона.

## Источники

- Запрос владельца 2026-06-23 (fidelity-ревьюер + дизайн под все экраны; дизайн = UI source of truth).
- Карта пайплайна (workflow `redesign-rules-map`, 2026-06-23): Mode B сегодня делает скриншоты, но fidelity-diff
  НЕ оформлен как обязательный гейт с покрытием всех классов — это правило закрывает gap.
