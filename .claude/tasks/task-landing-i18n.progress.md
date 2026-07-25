# task-landing-i18n — progress / completion summary

Ветка: `feature/landing-i18n`. Все 10 AC (A1–A10) реализованы и проверены. Таблица со ссылками
на доказательства — в PR body (#421). **Review round 1 (Verdict: BLOCK, review #4779516621) —
все находки закрыты**, см. секцию ниже. **Orchestrator finding (issuecomment-5080204989,
2026-07-25) — структурный роутинг-баг + page-identity верификация — закрыт**, см. секцию в конце.

## Ключевые артефакты

- `apps/landing/app/i18n/` — `locale.ts`, `dictionary.ts`, `routes.ts`, `dictionaries/{en,uk,ru,es,pt}.ts`
  (барrel `dictionaries/index.ts` — ТОЛЬКО для тестов, не импортируется продакшен-кодом)
- `apps/landing/app/lib/vacancy-i18n.ts` — resolve title/description + hreflang-exclude по переводам
- `apps/landing/app/lib/seo.ts` — `buildHreflangAlternates()`
- `apps/landing/app/lib/use-document-head.ts` — `htmlLang` + `alternates`
- `apps/landing/app/components/marketing/language-switcher.tsx` — переключатель (шапка+футер),
  принимает `path` пропом (не хардкодит)
- `apps/landing/app/components/marketing/pages/*-page-content.tsx` — общий JSX на 5 локалей,
  принимают `dict: Dictionary` пропом (не вызывают `getDictionary()` сами)
- `apps/landing/app/routes/index.tsx` (EN) + `{ru,uk,es,pt}.index.tsx` (+ `.careers` /
  `.careers_.$slug` для каждой локали) — 15 route-файлов, каждый статически импортирует ТОЛЬКО
  свой словарь напрямую (code-splitting). `{ru,uk,es,pt}.index.tsx` — переименованы из
  `{ru,uk,es,pt}.tsx` при orchestrator-finding фиксе (см. секцию ниже) — `.tsx` без `.index`
  делало файл ROOT-PARENT своих `.careers`/`.careers_.$slug` siblings вместо sibling'а EN.
- `apps/landing/scripts/prerender.mjs` — 5-locale routes, `assertHtmlLang` +
  `assertCanonicalSelf`/`assertAlternatesMatch`/`assertNoHomeJsonLdLeak` (page-identity gate,
  orchestrator finding), sitemap `xhtml:link`
- `apps/e2e/tests/landing/i18n.spec.ts` — 32 E2E-теста (реально прогнаны против prerendered
  build + vite preview)

## Review round 1 — что исправлено (см. PR body для полной таблицы)

- **HIGH-3**: `path` захардкожен `"/"` в nav.tsx/footer.tsx → LanguageSwitcher всегда вёл на
  home целевой локали. Фикс: `path` — явный проп от каждого `*-page-content.tsx`. Покрыто
  unit-матрицей (`nav-language-switcher-paths.spec.tsx`, 19 тестов) + E2E regression-тестом.
- **HIGH-1b/HIGH-2**: Lighthouse mobile performance 0.89 < 0.90 в CI; неверный диагноз в PR body
  убран. Реальная причина: `i18n/dictionaries/index.ts` barrel бандлил все 5 словарей в shared-чанк.
  Фикс: каждый route-файл импортирует свой словарь напрямую; компоненты принимают `dict` пропом.
  Shared-чанк: 237.64→187.79 KB (−49.85 KB / −14.11 KB gzip). Lighthouse после: 0.91/0.96/0.96/1.0
  на `/`, `/ru/`, `/es/` (стабильно, 3 прогона, pinned `lighthouse@12.6.1` = версия CI).
- **HIGH-4 (designer)**: CHALLENGE/SOLUTION хардкод в case-study-card.tsx → теперь пропсы из словаря.
- **MED-1**: error-баннер VacancyApplyForm никогда не локализовался (`result.message ??` никогда
  не срабатывал) → теперь резолвится из словаря по `errorKind`.
- **MED**: тач-таргеты переключателя 33.7px/37px → `min-h-11` (44px).
- **MED**: title-morph.ts locale-prefix логика без тестов → +11 unit-тестов.
- **LOW**: терминал "live" — осознанно оставлен английским, задокументировано.

## Верификация (реальные прогоны, не только unit)

- `pnpm --filter @crm/landing build:prerender` (post-fix) — успешно, 10 файлов на 5 локалях
- `vite preview` + Playwright `--project=landing tests/landing/i18n.spec.ts` — **22/22 passed**
- `vite dev` + `motion-v3.spec.ts`/`responsive.spec.ts` — 28/40 (12 падений — идентичны
  до-фикса, все от отсутствия локального API, не регрессия)
- `pnpm --filter @crm/landing test` — **185/185**; `tsc --noEmit` чисто; `eslint app` чисто
- Байт-в-байт подтверждение code-splitting: RU-текст 0 вхождений в shared-чанке (было 1),
  1 вхождение в собственном `ru`-чанке

## Известные ограничения / follow-up (не блокируют Block A)

- A9: `scripts/devops/lighthouserc.json` (DevOps-зона) сегодня гейтит только `/` и `/careers/` —
  добавление `/ru/`+`/es/` вне моей зоны
- `__root.tsx` site-wide 404 остался English-only (не входит в 15 обязательных локальных маршрутов)
- Block C (#422, `feat(vacancies): i18n translations + JobPosting SEO enrichment`) — **ИСПРАВЛЕНИЕ**:
  предыдущая запись здесь ошибочно утверждала, что #422 смержен — на момент orchestrator-finding
  фикса (2026-07-25) PR #422 всё ещё **OPEN** (проверено `gh pr view 422`). `apps/landing/app/lib/api.ts`
  по-прежнему мокает `translations`/`isFallback` через локальный `.extend()`, как и было спроектировано
  (forward-compatible, не блокируется на порядке мержа T3). A10 остаётся на моке до мержа #422.
- FAQ-разметка + «похожие вакансии» на странице вакансии — ОТДЕЛЬНЫЙ заход по инструкции
  координатора, не трогал в этом раунде
- Design-gate Tier 2 (переключатель языка) — conformance-проверка ui-ux-designer/PM ещё не
  проведена (вне зоны coder)

## Orchestrator finding (issuecomment-5080204989, 2026-07-25) — routing bug + page-identity gate

**Симптом**: `/ru/careers/`, `/uk/careers/`, `/es/careers/`, `/pt/careers/` (найдено владельцем
вручную) рендерили HOME-страницу локали вместо списка вакансий — 200, корректный `lang`, но
title/h1/canonical byte-identical странице `/ru/`. Vacancy-detail маршруты (`.careers_.$slug`)
подозревались затронутыми тем же паттерном (не проверялось до этого фикса — 0 вакансий в билде).

**Root cause**: TanStack Router file-based nesting. `app/routes/ru.tsx` (`createFileRoute('/ru')`,
рендерит `HomePageContent` напрямую, БЕЗ `<Outlet/>`) становится ROOT-ROUTE родителем своих же
`ru.careers.tsx` / `ru.careers_.$slug.tsx` (dot-nesting convention) — родитель, рендерящий
собственный компонент, поглощает контент любого совпавшего child-маршрута. Подтверждено чтением
`routeTree.gen.ts`: `RuCareersRoute`/`RuCareersSlugRoute` имели `getParentRoute: () => RuRoute`
вместо `() => rootRouteImport`.

**Выбранный фикс — Вариант A** (переименование, НЕ layout+`<Outlet/>`): `git mv
app/routes/{ru,uk,es,pt}.tsx → {ru,uk,es,pt}.index.tsx`. Обоснование выбора:

1. Зеркалит уже существующую EN-структуру (`index.tsx` + `careers.tsx` — siblings, не nested) —
   один паттерн на все 5 локалей, а не EN-исключение + Outlet-паттерн для остальных 4.
2. Прямой прецедент в этой же монорепе: `apps/web/app/routes/_authenticated/admin/tos.index.tsx`
   — `.index.tsx` под nested-префиксом уже используется проектом.
3. Вариант B (layout+`<Outlet/>`) добавил бы промежуточный layout-компонент без реальной общей
   разметки между home/careers/vacancy (в отличие от, например, `_authenticated` layout) — чистый
   overhead ради обхода нейминга, а не архитектурная польза.

Rebuild подтвердил: TanStack Vite plugin авто-переписал `createFileRoute('/ru')` →
`createFileRoute('/ru/')` в каждом файле; `routeTree.gen.ts` теперь показывает
`getParentRoute: () => rootRouteImport` для ВСЕХ 15 маршрутов, включая `*CareersSlugRoute`
(vacancy detail).

**Почему все существующие гейты пропустили баг** (третий рецидив этого класса в проекте —
presence-check вместо identity-check): `assertRobotsMeta`/`assertHtmlLang`/`assertJsonLd` в
`prerender.mjs`, зелёный CI, review round 1's "проверил A4 на реальном dist", designer-approval и
собственное "10/10 prerender files passed" этой же сессии — ВСЕ проверяли только, что тег
ПРАВИЛЬНОЙ ФОРМЫ присутствует, ни один не проверял, что контент СТРАНИЦЫ принадлежит этому URL.
`assertJsonLd` в частности молча пропускает валидацию при `requireJsonLd === null` (careers-list
с 0 вакансий) — именно поэтому баг прошёл мимо JSON-LD проверки на билде без вакансий.

**Новые машинные гейты** (`apps/landing/scripts/prerender.mjs`, теперь часть `build:prerender`,
падает билд при регрессии, не просто предупреждает):

- `assertCanonicalSelf(html, route)` — canonical ОБЯЗАН равняться собственному абсолютному URL
  маршрута (`route.path`/`route.locale`, ground truth из `buildRoutes()`), не переизвлечённому
  из (потенциально неверного) захваченного HTML.
- `assertAlternatesMatch(html, route)` — hreflang-alternates ОБЯЗАНЫ указывать на ТОТ ЖЕ тип
  страницы на каждой другой локали (`computeAlternateHrefs()`, общий с sitemap-генератором).
- `assertNoHomeJsonLdLeak(html, route)` — Organization/WebSite JSON-LD эксклюзивен для home;
  его наличие на любом другом `pageType` — однозначное доказательство подмены роута. НЕ
  no-op'ится на 0-вакансийном билде (в отличие от `assertJsonLd`) — закрывает именно тот
  blind spot, из-за которого баг проскочил изначально.

**Верификация (полный прогон)**:

- Rebuild (`vite build && node scripts/prerender.mjs`) против throwaway mock vacancies API
  (plain `node:http`, 1 seeded PUBLISHED вакансия `senior-ml-engineer`, БЕЗ БД — `packages/shared`
  ещё не имеет `translations` поля, т.к. #422 не смержен) — **все 15 маршрутов × 3 новых
  ассерта прошли на ПЕРВОЙ попытке** (0 retry-предупреждений в логе).
- Ручная сверка dist-файлов: title/h1/canonical корректны на ВСЕХ 15 файлах для ВСЕХ 5 локалей
  (включая vacancy-detail — h1 несёт `data-vacancy-morph-slug="senior-ml-engineer"`, которого
  НЕТ на home).
- `apps/landing/app/__tests__/prerender-seo.spec.ts` — +unit-тесты на новые функции
  (`computeAlternateHrefs`/`assertCanonicalSelf`/`assertAlternatesMatch`/`assertNoHomeJsonLdLeak`),
  каждый "throws"-кейс — прямой репро сломанного билда. **196/196** (было 185, +11 тестов из
  review round 1 title-morph + новые).
- `apps/e2e/tests/landing/i18n.spec.ts` — 2 новых describe-блока: (1) careers h1/canonical
  реально отличаются от home + список вакансий реально отрисован (не просто непустой h1); (2)
  vacancy-detail страница на каждой локали несёт detail-контент, не home. **32/32** (было 22,
  +10 новых, все 5 локалей).
- `tsc --noEmit` чисто (landing); `apps/e2e/tests/landing/i18n.spec.ts` — 0 ошибок в scoped
  typecheck прогоне (остальные e2e-файлы с pre-existing ошибками — чужая зона, не трогал).
