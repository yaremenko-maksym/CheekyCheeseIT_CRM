# PWA Static Asset Caching — Design Spec

**Date:** 2026-06-06
**Author:** Coder agent
**Status:** Implemented (feat/pwa-static-caching)

---

## Цель

Добавить Service Worker кеширование статических ассетов фронта чтобы:

- Ускорить повторные загрузки (статика из кеша — 0ms latency)
- Обеспечить базовую offline-resilience для shell приложения
- Не сломать существующий auth/data/media флоу

---

## Аудит-выводы (pre-implementation)

### Что уже кешируется — НЕ трогать

- **Медиа (аватары/чеки/документы):** S3 immutable + presigned URLs + TanStack Query `staleTime: 4h`. SW по presigned-URL медиа бесполезен (URL меняется каждый запрос) и небезопасен для приватных чеков.
- **Генерируемые PDF (контракты/инвойсы):** `Cache-Control: no-store, private` — намеренно не кешируются, SW не должен трогать.

### Что не кешируется — наш таргет

Prod-фронт отдаётся `vite preview`. Статика хеширована (`assets/index-[hash].js`) — готова к immutable caching. Service Worker отсутствует.

---

## Выбранный подход

**`vite-plugin-pwa@1.3.0` с `generateSW` стратегией (Workbox)**

### Решения

| Решение        | Выбор                       | Обоснование                                                                                                    |
| -------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------- | --- | --- | --- | --- | --- | ---- |
| Плагин         | `vite-plugin-pwa`           | Zero-config, Vite 6 compatible (`^3.1                                                                          |     | ^4  |     | ^5  |     | ^6`) |
| Стратегия SW   | `generateSW`                | Нет кастомного SW кода, Workbox генерирует автоматически                                                       |
| Регистрация SW | `injectRegister: 'inline'`  | Избегает `virtual:pwa-register` в Rollup module graph (pnpm workspace: `zod` не hoisted в root `node_modules`) |
| `registerType` | `autoUpdate`                | SW обновляется автоматически в фоне без промпта пользователя                                                   |
| dev-режим      | `devOptions.enabled: false` | SW в dev = stale-кеш, ломает hot-reload                                                                        |
| Манифест       | `manifest: false`           | Существующий `public/site.webmanifest` самодостаточен                                                          |

### Что precache'ится

```
**/*.{js,css,html,ico,png,svg,woff2,webmanifest}
```

Хешированные JS/CSS бандлы (`revision: null` — immutable, cache-forever) + статика из `public/` с revision hash.

### SPA routing

`navigateFallback: '/index.html'` — все навигационные запросы получают shell приложения. TanStack Router разруливает маршруты на клиенте.

---

## Исключения (что SW НЕ трогает)

| Тип                   | Почему исключён                                                           |
| --------------------- | ------------------------------------------------------------------------- |
| `/api/*`              | Auth/данные — кешировать опасно. `navigateFallbackDenylist: [/^\/api\//]` |
| S3 presigned-URL      | URL меняется каждый запрос — кеш бесполезен; медиа приватные              |
| PDF инвойсы/контракты | `Cache-Control: no-store, private` — намеренно не кешируются              |
| runtimeCaching        | Не добавляем — только precache статики                                    |

---

## Стратегия обновления SW

- `skipWaiting: true` — новый SW активируется немедленно без ожидания закрытия вкладок
- `clientsClaim: true` — SW берёт контроль над всеми открытыми клиентами
- `cleanupOutdatedCaches: true` — устаревшие кеши удаляются при обновлении
- `registerType: 'autoUpdate'` — плагин автоматически инжектирует логику обновления

Эффект: при деплое нового бандла SW обновляется в фоне, страница перезагружается автоматически.

---

## Риски и митигации

| Риск                       | Митигация                                                                   |
| -------------------------- | --------------------------------------------------------------------------- |
| Stale SW в production      | `autoUpdate` + `skipWaiting` + `cleanupOutdatedCaches`                      |
| Stale кеш в dev            | `devOptions.enabled: false` — SW не активен в dev                           |
| `/api` в precache          | `navigateFallbackDenylist` исключает, `runtimeCaching` отсутствует          |
| Приватные медиа в кеше     | S3 URL не в globPatterns; runtimeCaching не добавлен                        |
| pnpm workspace zod resolve | `injectRegister: 'inline'` вместо `virtual:pwa-register` — обходит проблему |

---

## Out-of-scope (follow-up)

- **Глубокий кеш медиа через стабильные URL** — нужны постоянные URL (не presigned) для S3 публичных ассетов. Отдельная задача Phase 7+.
- **Offline-first data** — полноценный offline режим с background sync. Не нужен для CRM.
- **Push notifications** — отдельная задача для notifications module.

---

## Артефакты реализации

- `apps/web/vite.config.ts` — `VitePWA({...})` плагин
- `apps/web/app/client.tsx` — комментарий (registerSW через inline script)
- `apps/web/package.json` — `vite-plugin-pwa: ^1.3.0` devDependency
- `dist/sw.js` — генерируется при каждом `vite build`
- `dist/workbox-*.js` — Workbox runtime (precache/routing)
- `dist/index.html` — содержит `<script id="vite-plugin-pwa:inline-sw">` для регистрации SW
