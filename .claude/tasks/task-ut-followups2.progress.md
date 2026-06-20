# Progress: task-ut-followups2

current_milestone: 1/4
last_commit: (none yet)
last_push: (none yet)

files_done: []
files_pending:

- apps/web/app/routes/crm/admin/templates/route.tsx (#1 AnimatedTabs)
- apps/web/app/routes/crm/admin/templates/contracts.index.tsx (#1 убрать версию)
- apps/web/app/routes/crm/admin/templates/contracts.$role.tsx (#2 confirm dialog + #3 highlight/preview)
- apps/web/app/routes/crm/admin/templates/tos.new.tsx (#2 confirm dialog)
- apps/web/app/components/user-profile/contract/ContractEditor.tsx (#3 подсветка + preview)
- apps/api/src/finance/payout-create.smoke.integration.spec.ts (#4 новый тест)

blast_radius:

- AnimatedTabs: 3 callers (RequisitesEditForm, UserProfileShell) — мы только добавляем ещё один caller, signature не меняем
- ContractEditor: 4 callers (ContractTab, UserDialog) — добавляем props с опциональными полями, BC-safe
- useContractTokens: 3 callers — не меняем
- contracts.$role.tsx: confirm dialog уже есть (showConfirm стейт), меняем только текст диалога (требование владельца: обновить текст)
- tos.new.tsx: confirm dialog уже есть — тоже только текст

notes:

- contracts.$role.tsx УЖЕ имеет confirm-диалог и preview-таб. Задача #2 по тексту диалога + #3 подсветка в left CodeMirror
- tos.new.tsx УЖЕ имеет confirm-диалог. Обновить текст.
- admin templates route.tsx: /crm/admin/templates (не /crm/admin) — используем правильный путь
