# task-junior-ux-3-cleanup — progress sentinel

current_milestone: 5/5 COMPLETE
last_commit: feat(junior-ux): cleanup — finance/docs/profile UX + defers M1-M5 all done
last_push: pending

## Milestones

- [x] M0 — session recovery, читаем файлы
- [x] M1 — dedup API access helpers (hrCanAccessProject + getHrSeniorIds → shared, leftAt fix)
- [x] M2 — ContractMeDto → shared schema; legend 2-col desktop layout
- [x] M3 — Finance JUNIOR view: контекст проект/период/статус-расшифровка/TX hash тултип
- [x] M4 — Documents JUNIOR: убрать Архив/disabled, исправить subtitle, CONTRACT добавить в JUNIOR
- [x] M5 — Profile JUNIOR: убрать чужие профили; typecheck + lint + E2E gate

## blast_radius

Изменяемые символы:

- `getHrSeniorIds` (projects.service.ts) — call sites: `findAll`, `assertHrAccess`, `findOne`
- `hrCanAccessProject` (projects.service.ts private) — call sites: `getHrContact`
- `TAB_VISIBILITY['JUNIOR']` (documents.tsx) — только UI, нет бэк call-sites
- `ContractMeDto` (project.tsx inline) — переносим в shared, call-sites: project.tsx

## files_done: []

## files_pending: [projects.service.ts, packages/shared/src/schemas/contracts.ts, apps/web/app/routes/crm/legend.tsx, apps/web/app/routes/crm/finance/index.tsx, apps/web/app/routes/crm/documents.tsx]
