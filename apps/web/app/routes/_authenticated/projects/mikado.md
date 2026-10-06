# Mikado: декомпозиция `$projectId.tsx`

Дисциплина: `.claude/skills/decomposing-large-code/SKILL.md`. Behavior-preserving; узлы — по именам
символов, не по строкам. Читать этот файл в начале каждой сессии по этому гиганту.

## Цель (низ графа)

`$projectId.tsx` -> тонкий композиционный корень (`Route` + `ProjectDetailPage` как сборка);
все автономные под-компоненты, хуки и диалоги вынесены в свои файлы; наблюдаемое поведение
неизменно (E2E projects-спеки + unit-тесты зелёные без правок).

## Сеть под кодом

- unit: `__tests__/InfoRow.structure.test.tsx`, `ProjectEditFields.test.tsx`,
  `PendingShareApprovalBanner.copy.test.tsx`, `ProjectHeaderApprovalNote.test.tsx`, `constants.test.ts`
- композиция страницы unit-тестов не имеет -> опора на E2E `projects*.spec.ts`

## Граф (листья сверху, цель снизу; стрелка = «нужно сделать раньше»)

Уровень 1 — чистые автономные листья (предпосылок нет):

- [done] `InfoRow`, `ProjectShareInfo`, `ProjectDropShareInfo` -> `ProjectInfoRows.tsx`
- [done] `PendingShareApprovalBanner`, `ProjectHeaderApprovalNote` -> `ProjectApprovalBanners.tsx`
- [done] `ProjectEffectiveTeamCard`, `MemberRow`, `ProjectDropDistribution` -> `ProjectTeamCards.tsx`
  (предпосылка `ROLE_VARIANT` вынесена в `constants.ts` — общая для `MemberRow` и страницы)
- [done] `ProjectTransactions` -> `ProjectTransactions.tsx` (лист 6; characterization: `__tests__/ProjectTransactions.test.tsx`)
- [done] `ProjectUnarchiveHeaderButton`, `ProjectCascadeUnarchiveModal` -> `ProjectUnarchive.tsx`
- [done] `EDIT_FIELD_LABEL_MESSAGES` -> `constants.ts` (общая для страницы и `ProjectEditFields`);
  `AnyField`/`AnyForm` переехали в `ProjectEditFields.tsx` (нужны только ему); `coerceDomain` остаётся в странице
  (используется только ею)
- [done] `ProjectEditFields` -> `ProjectEditFields.tsx` (лист 5)
- [done] хук `useProjectPermissions(user, project)` -> `use-project-permissions.ts` (лист 7; 8 флагов:
  `isAdmin`, `canManage`, `canOpenEdit`, `canRemoveMembers`, `canSeeProjectFinance`, `canEditOverride`,
  `canAccessLegend`, `canManageCredentials`; `isSubject` внутренний; characterization:
  `__tests__/use-project-permissions.test.ts`, роли x состояния проекта)
- [done] хук `useProjectDropMutations(projectId, onSuccessClose)` -> `use-project-drop-mutations.ts` (лист 8;
  единственная drop-мутация `dropMutation` — PATCH `{ dropId }` для attach/detach; страница передаёт
  `onSuccessClose`, закрывающий оба диалога; инвалидации/toast перенесены дословно;
  characterization: `__tests__/use-project-drop-mutations.test.tsx`). `addMemberMutation`/`removeMemberMutation`
  остались в странице (member-, не drop-мутации; завязаны на локальные `Set`-состояния)

Уровень 2 — нужен дизайн интерфейса (предпосылки: уровень 1):

- [done] `ProjectEditDialog` -> `ProjectEditDialog.tsx` (лист 13, последний; компонент владеет `editForm` +
  `editMutation` и `coerceDomain`; `onSubmit` с field-scoped RBAC (`paymentType`/override только при
  `canEditOverride`) перенесён побайтово; imperative `openEdit()` заменён reset-on-open по `open` (не по `project`);
  страница держит `editOpen` и флаги `useProjectPermissions`; characterization: `__tests__/ProjectEditDialog.test.tsx`)
- [done] диалоги drop-picker + detach-drop -> `ProjectDropDialogs.tsx` (лист 9; компонент владеет
  `useProjectDropMutations`, успех закрывает оба диалога через `onCloseDropPicker`/`onCloseDetachDropConfirm`;
  страница держит open-состояния, `dropCandidates` и гейт `canManageDrop` на кнопках-триггерах;
  characterization: `__tests__/ProjectDropDialogs.test.tsx`)
- [todo] диалоги remove-member / add-member <- `useProjectPermissions`
- [done] overview-таб -> `ProjectOverviewTab.tsx` (лист 12; три блока `activeTab === 'overview'` (карточки деталей/состава, legend, credentials) одним компонентом-фрагментом; страница передаёт `project`, `projectId`, viewer id/role, флаги `canManage`/`canRemoveMembers`/`canSeeProjectFinance`/`canEditOverride`/`canAccessLegend`/`canManageCredentials` (гейт credentials не менялся), `availableToAddCount` и колбэки `onAddMember`/`onRemoveMember`; characterization: `__tests__/ProjectOverviewTab.test.tsx`)
- [done] hero-хедер -> `ProjectHero.tsx` (лист 11; страница передаёт `project`, viewer id/role, `rates`, флаги `isAdmin`/`canOpenEdit` и колбэки `onEdit`/`onArchive`/`onCascadeRequired`; PendingShareApprovalBanner остаётся в странице; characterization: `__tests__/ProjectHero.test.tsx`)

Риск-зоны: finance-маскирование (`canSeeProjectFinance`); порядок хуков до early-return
(Rules of Hooks); field-scoped RBAC в submit.

Цель <- все узлы выше.
