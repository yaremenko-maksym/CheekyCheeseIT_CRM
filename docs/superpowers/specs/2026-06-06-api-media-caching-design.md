# API + S3-Media Caching — Design Spec

**Date:** 2026-06-06
**Branch:** feat/api-media-caching
**Status:** Implemented (4 components)

---

## Architecture

### Caching layers

```
Browser request
  │
  ├─ Static assets (JS/CSS/HTML/icons)
  │    └─ SW Precache (workbox, immutable hashed filenames, 24 entries)
  │
  ├─ S3 media (images, thumbnails)
  │    └─ SW CacheFirst "media-cache"
  │         key = origin+pathname (presigned query stripped)
  │         max 200 entries, 30 days
  │
  ├─ API GET /api/*
  │    └─ SW NetworkFirst "api-cache"
  │         timeout 4s → network, fallback → cache (offline)
  │         max 200 entries, 24 hours
  │
  └─ TanStack Query (in-memory + IndexedDB persist)
       persister: idb-keyval key="crm-query-cache"
       maxAge 12 hours, buster = VITE_APP_VERSION
```

### Components

**C1 — SW runtimeCaching** (`vite.config.ts`)

- `media-cache`: `CacheFirst` for cross-origin images (S3 presigned URLs).
  The key is normalized — the X-Amz-\* query parameters are stripped. S3 objects
  are immutable, the content for a single pathname is always the same.
- `api-cache`: `NetworkFirst` for `/api/*` GET requests. Online = fresh
  data from the network; offline = cache as a fallback. `networkTimeoutSeconds: 4`.

**C2 — persistQueryClient** (`__root.tsx` + `lib/persister.ts`)

- `PersistQueryClientProvider` instead of `QueryClientProvider`.
- Persister on `idb-keyval` (IndexedDB, zero-deps).
- `maxAge: 12h` — the cache is valid for 12 hours after write.
- `buster: VITE_APP_VERSION` — on deploy the old cache is automatically
  invalidated (different buster strings = different IDB keys).

**C3 — logout-clear** (`routes/crm/route.tsx`)

- `queryClient.clear()` — reset the in-memory TanStack Query cache.
- `idbClear()` — delete the persist store from IndexedDB.
- `caches.delete(k)` for `api-cache` and `media-cache` — the SW runtime caches.
- The precache store (`workbox-precache-*`) is not touched — static assets contain no
  user data.

**C4 — mutation audit** (4 files)

Gaps in `invalidateQueries` were filled (see the table below).

---

## Anti-stale strategy

| Level          | Mechanism                                                | Result                            |
| -------------- | -------------------------------------------------------- | --------------------------------- |
| SW             | `NetworkFirst` for `/api/*`                              | Online always gets fresh data     |
| TanStack Query | `invalidateQueries` in every mutation                    | After a write — immediate refetch |
| Persist        | `buster=VITE_APP_VERSION`                                | Deploy resets the old IDB cache   |
| Logout         | `queryClient.clear()` + `idbClear()` + `caches.delete()` | User switch = clean start         |

---

## Mutation audit table (C4)

| Mutation                                        | File                                                     | Keys: before                                      | Keys: added                                 |
| ----------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------- |
| `useAdminUpdateUser`                            | `hooks/use-user-profile.ts`                              | `['user-profile', userId]`                        | `['users']`, `['users-admin']`              |
| `useAdminChangeRole`                            | `hooks/use-user-profile.ts`                              | `['user-profile', userId]`                        | `['users']`, `['users-admin']`, `['teams']` |
| `useAdminChangeSalary`                          | `hooks/use-user-profile.ts`                              | `['user-profile', userId]`                        | `['users-admin']`                           |
| `useAdminChangeRequisites`                      | `hooks/use-user-profile.ts`                              | `['user-profile', userId]`                        | `['users-admin']`                           |
| `createMutation` (CreateProjectFromHiredDialog) | `interviews/components/CreateProjectFromHiredDialog.tsx` | — (onSuccess was absent)                          | `['projects']`                              |
| `confirm` (CryptoChannelCard)                   | `payments/initiate.$incomeId.tsx`                        | `['transaction', id]`, `['profile-transactions']` | `['transactions']`, `['finance-summary']`   |
| `removeMemberMutation`                          | `routes/crm/team/$teamId.tsx`                            | `['team', teamId]`                                | `['teams']`                                 |

### Mutations without gaps (checked, left as is)

The remaining 44 of 51 `useMutation` have full `invalidateQueries` for
all affected keys. Key examples:

- `use-archive.ts` — cascade invalidation for user/team/project.
- Finance dialogs (LogCash, Validate, Payout, PayoutDetail, PaySalary,
  DeleteTx, AdminEditTx, PendingSettlement, ConfirmPayout, EditSeniorIncome,
  CreateTransaction) — invalidate `transactions` + `finance-summary` + specific keys.
- Interviews (Create, Move, Update, Delete) — invalidate `['interviews']`.
- Team (rotateSenior, updateTeam, addMember) — invalidate `teams` + `users`.
- UserDialog (createUser, createDrop, updateUser, contractReady, editUser) — full sets.
- Contract hooks (update, ready, revert, reset) — `contractKeys.detail(userId)`.
- ToS / ContractTemplate — `tos-*` / `contract-template-*`.
- RejoinTeamDialog — 7 keys including `auth`, `me`.
- `projects/$projectId.tsx` — update/removeMember/addMember.
- `payments/initiate.$incomeId.tsx` — supplemented in C4.

---

## What is NOT cached

- `POST/PATCH/DELETE` requests — the SW does not intercept mutations.
- PDF (contracts, invoices) — served with `Cache-Control: no-store, private`.
- Auth endpoints (`/api/auth/*`) — the SW is not cached by pathname, but
  `NetworkFirst` covers them (online-first always).
- Presigned URL as a URL — cached only by `origin+pathname` without the query.

---

## Manual QA (on PM)

- [ ] Offline mode: open the CRM, disable the network, reload — it should
      work from the cache (API data from `api-cache`, media from `media-cache`).
- [ ] Anti-stale: change data via a mutation — the list should update
      without a manual refresh.
- [ ] Logout-clear: log out → log in as another user — the first user's old data
      must not flash.
- [ ] Deploy buster: on a `VITE_APP_VERSION` change the old IDB cache should
      reset (check via DevTools → Application → IndexedDB).
