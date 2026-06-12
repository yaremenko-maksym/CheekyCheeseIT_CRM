# task-junior-ux-2-hub progress sentinel

current_milestone: 1/6
last_commit: none
last_push: none
branch: feature/junior-ux-hub

files_done: []
files_pending:

- apps/api/src/projects/projects.controller.ts (hr-contact endpoint)
- apps/api/src/projects/projects.service.ts (getHrContact method)
- packages/shared/src/schemas/projects.ts (HrContactDto schema — check existing)
- apps/web/app/routes/crm/project.tsx (JuniorProjectHub rewrite)
- apps/web/app/routes/crm/legend.tsx (new LegendPage)
- apps/web/app/components/crm/nav-sidebar.tsx (JUNIOR nav + redirect)
- apps/web/app/routes/crm/index.tsx (JUNIOR redirect)
- apps/e2e/tests/junior-hub.spec.ts (new E2E spec)

blast_radius:

- apps/web/app/routes/crm/project.tsx: full rewrite (was redirect-only)
- apps/web/app/components/crm/nav-sidebar.tsx: add JUNIOR items + remove old items
- apps/web/app/routes/crm/index.tsx: add JUNIOR redirect (existing DROP redirect unchanged)

milestones:
1: API hr-contact endpoint + schema
2: JUNIOR nav + redirect (nav-sidebar + index.tsx)
3: JuniorProjectHub + sub-components (hub page)
4: LegendPage (legend page)
5: E2E spec
6: typecheck + lint + E2E local run + screenshots

ac_verified: pending
