# API + S3-Media Caching — Design Spec

**Date:** 2026-06-06
**Branch:** feat/api-media-caching
**Status:** Implemented (4 components)

---

## Архитектура

### Слои кеширования

```
Browser request
  │
  ├─ Static assets (JS/CSS/HTML/icons)
  │    └─ SW Precache (workbox, immutable hashed filenames, 24 entries)
  │
  ├─ S3 media (images, thumbnails)
  │    └─ SW CacheFirst "media-cache"
  │         key = origin+pathname (presigned query срезается)
  │         max 200 entries, 30 дней
  │
  ├─ API GET /api/*
  │    └─ SW NetworkFirst "api-cache"
  │         timeout 4s → network, фолбэк → кеш (offline)
  │         max 200 entries, 24 часа
  │
  └─ TanStack Query (in-memory + IndexedDB persist)
       persister: idb-keyval key="crm-query-cache"
       maxAge 12 часов, buster = VITE_APP_VERSION
```

### Компоненты

**C1 — SW runtimeCaching** (`vite.config.ts`)

- `media-cache`: `CacheFirst` для cross-origin images (S3 presigned URLs).
  Ключ нормализуется — срезаются X-Amz-\* query-параметры. S3-объекты
  иммутабельны, контент по одному pathname всегда одинаков.
- `api-cache`: `NetworkFirst` для `/api/*` GET-запросов. Онлайн = свежие
  данные с сети; оффлайн = кеш как фолбэк. `networkTimeoutSeconds: 4`.

**C2 — persistQueryClient** (`__root.tsx` + `lib/persister.ts`)

- `PersistQueryClientProvider` вместо `QueryClientProvider`.
- Persister на `idb-keyval` (IndexedDB, zero-deps).
- `maxAge: 12h` — кеш валиден 12 часов после записи.
- `buster: VITE_APP_VERSION` — при деплое старый кеш автоматически
  инвалидируется (разные строки buster = разные ключи IDB).

**C3 — logout-clear** (`routes/crm/route.tsx`)

- `queryClient.clear()` — сброс in-memory кеша TanStack Query.
- `idbClear()` — удаление persist-стора из IndexedDB.
- `caches.delete(k)` для `api-cache` и `media-cache` — SW runtime кеши.
- Precache-стор (`workbox-precache-*`) не трогается — статика не содержит
  данных пользователя.

**C4 — mutation audit** (4 файла)

Заполнены пробелы в `invalidateQueries` (см. таблицу ниже).

---

## Анти-stale стратегия

| Уровень        | Механизм                                                 | Результат                            |
| -------------- | -------------------------------------------------------- | ------------------------------------ |
| SW             | `NetworkFirst` для `/api/*`                              | Онлайн всегда получает свежие данные |
| TanStack Query | `invalidateQueries` в каждой мутации                     | После записи — немедленный рефетч    |
| Persist        | `buster=VITE_APP_VERSION`                                | Деплой сбрасывает старый IDB-кеш     |
| Logout         | `queryClient.clear()` + `idbClear()` + `caches.delete()` | Смена пользователя = чистый старт    |

---

## Таблица аудита мутаций (C4)

| Мутация                                         | Файл                                                     | Ключи: было                                       | Ключи: добавлено                            |
| ----------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------- |
| `useAdminUpdateUser`                            | `hooks/use-user-profile.ts`                              | `['user-profile', userId]`                        | `['users']`, `['users-admin']`              |
| `useAdminChangeRole`                            | `hooks/use-user-profile.ts`                              | `['user-profile', userId]`                        | `['users']`, `['users-admin']`, `['teams']` |
| `useAdminChangeSalary`                          | `hooks/use-user-profile.ts`                              | `['user-profile', userId]`                        | `['users-admin']`                           |
| `useAdminChangeRequisites`                      | `hooks/use-user-profile.ts`                              | `['user-profile', userId]`                        | `['users-admin']`                           |
| `createMutation` (CreateProjectFromHiredDialog) | `interviews/components/CreateProjectFromHiredDialog.tsx` | — (onSuccess отсутствовал)                        | `['projects']`                              |
| `confirm` (CryptoChannelCard)                   | `payments/initiate.$incomeId.tsx`                        | `['transaction', id]`, `['profile-transactions']` | `['transactions']`, `['finance-summary']`   |
| `removeMemberMutation`                          | `routes/crm/team/$teamId.tsx`                            | `['team', teamId]`                                | `['teams']`                                 |

### Мутации без пробелов (проверены, оставлены как есть)

Остальные 44 из 51 `useMutation` имеют полные `invalidateQueries` для
всех затронутых ключей. Ключевые примеры:

- `use-archive.ts` — cascade invalidation для user/team/project.
- Finance dialogs (LogCash, Validate, Payout, PayoutDetail, PaySalary,
  DeleteTx, AdminEditTx, PendingSettlement, ConfirmPayout, EditSeniorIncome,
  CreateTransaction) — инвалидируют `transactions` + `finance-summary` + специфичные ключи.
- Interviews (Create, Move, Update, Delete) — инвалидируют `['interviews']`.
- Team (rotateSenior, updateTeam, addMember) — инвалидируют `teams` + `users`.
- UserDialog (createUser, createDrop, updateUser, contractReady, editUser) — полные наборы.
- Contract hooks (update, ready, revert, reset) — `contractKeys.detail(userId)`.
- ToS / ContractTemplate — `tos-*` / `contract-template-*`.
- RejoinTeamDialog — 7 ключей включая `auth`, `me`.
- `projects/$projectId.tsx` — update/removeMember/addMember.
- `payments/initiate.$incomeId.tsx` — дополнено в C4.

---

## Что НЕ кешируется

- `POST/PATCH/DELETE` запросы — SW не перехватывает мутации.
- PDF (контракты, инвойсы) — отдаются с `Cache-Control: no-store, private`.
- Auth endpoints (`/api/auth/*`) — SW не кешируется по pathname, но
  `NetworkFirst` их покрывает (online-first всегда).
- Presigned URL как URL — кешируется только по `origin+pathname` без query.

---

## Manual QA (на PM)

- [ ] Оффлайн-режим: зайти в CRM, отключить сеть, перезагрузить — должно
      работать из кеша (API данные из `api-cache`, медиа из `media-cache`).
- [ ] Анти-stale: изменить данные через мутацию — список должен обновиться
      без ручного рефреша.
- [ ] Logout-clear: выйти → войти под другим пользователем — старые данные
      первого пользователя не должны мелькать.
- [ ] Деплой buster: при смене `VITE_APP_VERSION` старый IDB-кеш должен
      сброситься (проверить через DevTools → Application → IndexedDB).
