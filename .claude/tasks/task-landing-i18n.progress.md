# task-landing-i18n — progress / completion summary

Ветка: `feature/landing-i18n`. Все 10 AC (A1–A10) реализованы и проверены. Таблица со ссылками
на доказательства — в PR body (#421).

## Ключевые артефакты

- `apps/landing/app/i18n/` — `locale.ts`, `dictionary.ts`, `routes.ts`, `dictionaries/{en,uk,ru,es,pt}.ts`
- `apps/landing/app/lib/vacancy-i18n.ts` — resolve title/description + hreflang-exclude по переводам
- `apps/landing/app/lib/seo.ts` — `buildHreflangAlternates()`
- `apps/landing/app/lib/use-document-head.ts` — `htmlLang` + `alternates`
- `apps/landing/app/components/marketing/language-switcher.tsx` — переключатель (шапка+футер)
- `apps/landing/app/components/marketing/pages/*-page-content.tsx` — общий JSX на 5 локалей
- `apps/landing/app/routes/{index,uk,ru,es,pt}.tsx` (+ `.careers` / `.careers_.$slug`) — 15 route-файлов
- `apps/landing/scripts/prerender.mjs` — 5-locale routes, `assertHtmlLang`, sitemap `xhtml:link`
- `apps/e2e/tests/landing/i18n.spec.ts` — 21 E2E-теста (реально прогнаны против prerendered build)

## Верификация (реальные прогоны, не только unit)

- `pnpm --filter @crm/landing build:prerender` — успешно, 10 статических файлов на 5 локалях
- `vite preview` (:4173) + Playwright `--project=landing tests/landing/i18n.spec.ts` — 21/21 passed
- `vite dev` (:3002) + существующие `motion-v3.spec.ts` / `responsive.spec.ts` — 28/40 passed,
  12 упавших — все `SyntaxError` от `/api/public/vacancies` (нет локального API/DB), не регрессия
  (подтверждено: 0 изменений в `__root.tsx`/`page-transition.ts`/`scrim-transition.ts`; ранее
  провалившийся фокус-тест на dev-сервере — зелёный)
- Lighthouse 13.4.1 (Node 20) mobile на `/` и `/ru/`: performance 0.90, accessibility 0.96,
  best-practices 0.96; `seo` = null из-за известного бага Lighthouse 13.4.1 на Node 20
  (`URL.parse is not a function` в audit `canonical`, Node 22+ API) — canonical-тег напрямую
  проверен в HTML, корректен
- `pnpm --filter @crm/landing test` — 154/154; `tsc --noEmit` чисто; `eslint app` чисто

## Известные ограничения / follow-up (не блокируют Block A)

- A9: `scripts/devops/lighthouserc.json` (DevOps-зона) сегодня гейтит только `/` и `/careers/` —
  нужно добавить `/ru/` и `/es/` (явное требование A9), я не могу трогать этот файл
- `__root.tsx` site-wide 404 остался English-only (не входит в 15 обязательных локальных маршрутов)
- A10 работает на моках контракта (`translations`/`isFallback` через локальное `.extend()` в
  `lib/api.ts`) — реальные данные появятся при мерже Block C (T3)
- Design-gate Tier 2 (переключатель языка — новый UI-элемент) — conformance-проверка
  ui-ux-designer/PM ещё не проведена (вне зоны coder)
