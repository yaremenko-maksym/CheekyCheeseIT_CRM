# task-fix-missed-pages-layout progress

current_milestone: 1/2
last_commit: —
last_push: —

## Audit results

### Broken (to fix):

1. stats.tsx — DONE
2. users/index.tsx — DONE
3. legend.tsx — pending
4. project.tsx — pending
5. payments/initiate.$incomeId.tsx — pending
6. admin/templates/contracts.index.tsx — pending

### Already OK (delegate / pass-through — DO NOT TOUCH):

- profile/index.tsx → UserProfileShell (migrated)
- profile/$userId.tsx → UserProfileShell (migrated)
- projects.tsx → pure Outlet pass-through
- routing.tsx — no layout (pass-through)

## blast_radius:

All route-local components — no shared export side effects.

## files_done: [stats.tsx, users/index.tsx]

## files_pending: [legend.tsx, project.tsx, payments/initiate.$incomeId.tsx, admin/templates/contracts.index.tsx]
