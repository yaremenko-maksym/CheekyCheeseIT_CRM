# Progress — task-junior-ut-round2 (review findings round 2)

branch: feature/junior-ut-round2
PR: #184
scratch_db: scratch_junr2 (postgresql://crm_user@[::1]:5432/scratch_junr2)

## Findings status

- [x] HIGH-1 — credentials.service.ts:450 scoped UPDATE + IDOR regress test (20 tests pass on scratch DB @127.0.0.1)
- [ ] HIGH-2 — users-access.service.spec.ts no-op mock rename + masking test
- [ ] MED-3 — ProfileCredentialsSection 30s auto-hide
- [x] MED-4 — assertUserCredentialsAccess role-check before DB SELECT
- [x] MED-5 — ParseUUIDPipe in integration mock-controller (400-on-malformed-uuid test)
- [ ] MED-6 — useJuniorProjects queryKey ['junior','projects'] (NOT in persist allow-list)
- [ ] LOW-7 — route-access coverage invariant test
- [x] LOW-8 — DEFER (0012_snapshot.json drizzle tech debt) — document in PR body

## blast_radius

- credentials.service.ts updateForUser :450 — callers: SentinelUserCredentialsController (integration spec), users.controller PATCH /users/:userId/credentials/:id
- useJuniorProjects ['projects'] → ['junior','projects'] — caller: project.tsx only (single hub usage)
- isJuniorUnderLegendSubject — already correct name; only the spec mock referenced wrong name

current_milestone: 0/7
