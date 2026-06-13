# task-fix-junior-ut-round3 — progress

current_milestone: 5/5
last_commit: 5e42014
last_push: 2026-06-13
status: DONE

## Milestones

- [x] M1 — 6a: remove `documents` tab from JUNIOR self-view allowlist + spec update
- [x] M2 — 6b: hide `tosAcceptedAt`/`tosVersion` from JUNIOR self-view + 3 regression tests
- [x] M3 — 4: credentials form reset on unmount (plaintext cleared on re-open) + `twoColumn` prop
- [x] M4 — fix `cn` import in ProjectCredentialsSection
- [x] M5 — 1/2/3/5: hub round3 redesign (items-start, left-stack, col-span-2 salary, rm ContractStatusCard, HR inline)

## blast_radius

- `users-access.service.ts` JUNIOR self allowlist → call-sites: `getViewPermissions()` in ProfileController, profile route (web), spec
- `users.service.ts` `buildProfileView` `canSeeTos` gate → call-sites: `getProfile` in UsersService; pinned with new tests
- `ProjectCredentialsSection.tsx` → call-sites: `project.tsx` (hub) + `profile/:userId` tabs — `twoColumn` prop backward-compatible (optional, false by default)
- `project.tsx` — removed `useMyContract`, `ContractStatusCard`, `HrContactCard`; no other callers

## ac_verified: 1,2,3,4,5,6

## vision: ✓ /crm/project (1440px + 768px), /crm/profile/$userId
