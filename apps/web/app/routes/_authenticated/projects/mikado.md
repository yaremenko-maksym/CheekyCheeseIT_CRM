# Mikado: decomposition of `$projectId.tsx`

Discipline: `.claude/skills/decomposing-large-code/SKILL.md`. Behavior-preserving; nodes are named by
symbol, not by line. Read this file at the start of every session on this giant.

## Goal (bottom of the graph)

`$projectId.tsx` -> a thin composition root (`Route` + `ProjectDetailPage` as an assembly);
all self-contained sub-components, hooks and dialogs are extracted into their own files; observable
behavior is unchanged (E2E projects specs + unit tests green without edits).

## Safety net under the code

- unit: `__tests__/InfoRow.structure.test.tsx`, `ProjectEditFields.test.tsx`,
  `PendingShareApprovalBanner.copy.test.tsx`, `ProjectHeaderApprovalNote.test.tsx`, `constants.test.ts`
- the page composition has no unit tests -> rely on the E2E `projects*.spec.ts`

## Graph (leaves on top, goal at the bottom; arrow = "must be done earlier")

Level 1 — pure self-contained leaves (no prerequisites):

- [done] `InfoRow`, `ProjectShareInfo`, `ProjectDropShareInfo` -> `ProjectInfoRows.tsx`
- [done] `PendingShareApprovalBanner`, `ProjectHeaderApprovalNote` -> `ProjectApprovalBanners.tsx`
- [done] `ProjectEffectiveTeamCard`, `MemberRow`, `ProjectDropDistribution` -> `ProjectTeamCards.tsx`
  (prerequisite `ROLE_VARIANT` moved to `constants.ts` — shared by `MemberRow` and the page)
- [done] `ProjectTransactions` -> `ProjectTransactions.tsx` (leaf 6; characterization: `__tests__/ProjectTransactions.test.tsx`)
- [done] `ProjectUnarchiveHeaderButton`, `ProjectCascadeUnarchiveModal` -> `ProjectUnarchive.tsx`
- [done] `EDIT_FIELD_LABEL_MESSAGES` -> `constants.ts` (shared by the page and `ProjectEditFields`);
  `AnyField`/`AnyForm` moved into `ProjectEditFields.tsx` (only it needs them); `coerceDomain` stays in the page
  (used only by it)
- [done] `ProjectEditFields` -> `ProjectEditFields.tsx` (leaf 5)
- [done] hook `useProjectPermissions(user, project)` -> `use-project-permissions.ts` (leaf 7; 8 flags:
  `isAdmin`, `canManage`, `canOpenEdit`, `canRemoveMembers`, `canSeeProjectFinance`, `canEditOverride`,
  `canAccessLegend`, `canManageCredentials`; `isSubject` is internal; characterization:
  `__tests__/use-project-permissions.test.ts`, roles x project states)
- [done] hook `useProjectDropMutations(projectId, onSuccessClose)` -> `use-project-drop-mutations.ts` (leaf 8;
  the single drop mutation `dropMutation` — PATCH `{ dropId }` for attach/detach; the page passes
  `onSuccessClose`, which closes both dialogs; invalidations/toast moved verbatim;
  characterization: `__tests__/use-project-drop-mutations.test.tsx`). `addMemberMutation`/`removeMemberMutation`
  stayed in the page (member mutations, not drop mutations; tied to local `Set` state)

Level 2 — interface design needed (prerequisites: level 1):

- [done] `ProjectEditDialog` -> `ProjectEditDialog.tsx` (leaf 13, the last one; the component owns `editForm` +
  `editMutation` and `coerceDomain`; `onSubmit` with field-scoped RBAC (`paymentType`/override only when
  `canEditOverride`) moved byte-for-byte; the imperative `openEdit()` is replaced by reset-on-open keyed on `open` (not on `project`);
  the page keeps `editOpen` and the `useProjectPermissions` flags; characterization: `__tests__/ProjectEditDialog.test.tsx`)
- [done] drop-picker + detach-drop dialogs -> `ProjectDropDialogs.tsx` (leaf 9; the component owns
  `useProjectDropMutations`, success closes both dialogs via `onCloseDropPicker`/`onCloseDetachDropConfirm`;
  the page keeps the open states, `dropCandidates` and the `canManageDrop` gate on the trigger buttons;
  characterization: `__tests__/ProjectDropDialogs.test.tsx`)
- [todo] remove-member / add-member dialogs <- `useProjectPermissions`
- [done] overview tab -> `ProjectOverviewTab.tsx` (leaf 12; the three `activeTab === 'overview'` blocks (details/team cards, legend, credentials) as a single fragment component; the page passes `project`, `projectId`, viewer id/role, the `canManage`/`canRemoveMembers`/`canSeeProjectFinance`/`canEditOverride`/`canAccessLegend`/`canManageCredentials` flags (the credentials gate is unchanged), `availableToAddCount` and the `onAddMember`/`onRemoveMember` callbacks; characterization: `__tests__/ProjectOverviewTab.test.tsx`)
- [done] hero header -> `ProjectHero.tsx` (leaf 11; the page passes `project`, viewer id/role, `rates`, the `isAdmin`/`canOpenEdit` flags and the `onEdit`/`onArchive`/`onCascadeRequired` callbacks; PendingShareApprovalBanner stays in the page; characterization: `__tests__/ProjectHero.test.tsx`)

Risk zones: finance masking (`canSeeProjectFinance`); hook order before the early return
(Rules of Hooks); field-scoped RBAC in submit.

Goal <- all nodes above.
