# task-landing-i18n — progress / completion summary

Ветка: `feature/landing-i18n`. Все 10 AC (A1–A10) реализованы и проверены. Таблица со ссылками
на доказательства — в PR body (#421). **Review round 1 (Verdict: BLOCK, review #4779516621) —
все находки закрыты**, см. секцию ниже.

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
- `apps/landing/app/routes/{index,uk,ru,es,pt}.tsx` (+ `.careers` / `.careers_.$slug`) — 15
  route-файлов, каждый статически импортирует ТОЛЬКО свой словарь напрямую (code-splitting)
- `apps/landing/scripts/prerender.mjs` — 5-locale routes, `assertHtmlLang`, sitemap `xhtml:link`
- `apps/e2e/tests/landing/i18n.spec.ts` — 22 E2E-теста (реально прогнаны против prerendered build)

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
- Block C (#422) смержен параллельно — A10 теперь на реальном контракте, не моке
- FAQ-разметка + «похожие вакансии» на странице вакансии — ОТДЕЛЬНЫЙ заход по инструкции
  координатора, не трогал в этом раунде
- Design-gate Tier 2 (переключатель языка) — conformance-проверка ui-ux-designer/PM ещё не
  проведена (вне зоны coder)
