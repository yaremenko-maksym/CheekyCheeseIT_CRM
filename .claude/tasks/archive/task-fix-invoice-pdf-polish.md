# task-fix-invoice-pdf-polish

## Агент: coder

## Приоритет: medium

## Ветка: fix/invoice-pdf-polish

## Зависит от: PR #74 (drop-pays-company + PDF refresh) — merged

## Контекст

После visual user testing инвойса (см. screenshot 02.06.2026) выявлены 3 проблемы:

1. **Иконка в header неправильная** — текущий «Wedge Terminal» SVG не подходит. Нужно использовать **тот же логотип что в frontend header** (через ast-grep найти компонент `BrandMark` / `Logo` / в `apps/web/app/components/layout/Header` или похожем).
2. **Данные исполнителя слишком подробные** — сейчас «CheekyCheeseIT, Адрес: Україна, м. Київ». Должно быть **только «CheekyCheeseIT»** без адреса и доп. полей.
3. **Сумма «1 000.00 USDT» криво вписана** — внизу, обрезается. Расположение/выравнивание/font size нужно поправить чтобы влезало корректно.

## Acceptance Criteria

### AC1. Иконка из frontend header

- [ ] Через ast-grep MCP найти компонент header logo в `apps/web/app/**` (искать `BrandMark`, `Logo`, `<header>`, layout file). Зафиксировать какой SVG/иконка реально используется.
- [ ] В `apps/api/src/invoices/invoice-pdf.service.ts` (или связанный) — заменить `drawBrandMark()` / `wedge-logo.svg` на тот же логотип что в header.
- [ ] Если frontend использует inline SVG / React component — экспортировать в standalone SVG в `apps/api/src/assets/brand/logo.svg` (заменив текущий wedge-logo.svg).
- [ ] Цвет/contrast подобрать под PDF (тёмный на белом фоне).

### AC2. Исполнитель — только «CheekyCheeseIT»

- [ ] В `invoice-pdf.service.ts` — секция «Исполнитель» должна содержать **только** название.
- [ ] Удалить адрес (`Україна, м. Київ`), удалить любые другие поля (email, phone, ИНН, etc.).
- [ ] Спейсинг после секции — нормальный (не пустое пространство там где был адрес).

### AC3. Layout сумма

- [ ] Текущий layout: «СУММА К ОПЛАТЕ» / «1 000.00 USDT» (22pt) внизу страницы — обрезается.
- [ ] Исправить:
  - Либо передвинуть выше (центрировать на странице, не в самом низу).
  - Либо уменьшить шрифт чтобы влезало в bottom padding.
  - Либо добавить explicit page-break / margin-bottom.
- [ ] Проверить что сумма видна полностью + не обрезается по правому краю при разных длинах (например `$10,000,000.00 USDT`).

### AC4. Visual verification

- [ ] **Обязательно** — сгенерировать пример PDF локально через invoice trigger (создать тестовую транзакцию → invoice auto-generated → скачать PDF из S3 / MinIO).
- [ ] **Открыть PDF через playwright MCP** (`browser_navigate` на presigned URL) + `browser_take_screenshot`.
- [ ] Визуально проверить:
  - Логотип в header — соответствует frontend header logo.
  - Исполнитель — только `CheekyCheeseIT`.
  - Сумма видна полностью, выровнена.
  - Никаких других регрессий (подпись, footer, layout остальных секций).
- [ ] Приложить screenshot к PR description (через `gh pr edit --body` или `gh pr comment` с image).

### AC5. UT

- [ ] `invoice-pdf.service.spec.ts` — обновить тесты если они проверяют:
  - Что `companyAddress` рендерится → теперь не должно (Исполнитель только название).
  - Что `drawBrandMark` использует определённый SVG path → теперь новый SVG.

### AC6. Локально

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @crm/web build
pnpm --filter @crm/e2e test
```

Все зелёные.

### AC7. PR

- [ ] Ветка `fix/invoice-pdf-polish`.
- [ ] Title: `fix(invoices): polish PDF — header logo из frontend, исполнитель=CheekyCheeseIT, сумма layout`.
- [ ] Body: что было / что стало (3 fixes), screenshot PDF before/after.

### AC8. Финальный отчёт

Coder ДОЛЖЕН включить (согласно RULES.md / coder.md):

```bash
git log origin/fix/invoice-pdf-polish -1 --oneline   # вывод
gh pr view <PR_NUM> --json number,headRefName,state   # вывод
```

- embedded screenshot of new PDF (через playwright MCP `browser_take_screenshot`).

## Что НЕ нужно

- Менять invoice signing flow.
- Менять кому отправляется уведомление.
- Менять content streams logic кроме layout.
- Использовать `--no-verify` (zero tolerance).

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
