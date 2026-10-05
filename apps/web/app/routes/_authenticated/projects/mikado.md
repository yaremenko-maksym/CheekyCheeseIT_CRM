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
- [todo] `ProjectTransactions`
- [done] `ProjectUnarchiveHeaderButton`, `ProjectCascadeUnarchiveModal` -> `ProjectUnarchive.tsx`
- [todo] константы/типы -> существующий `constants.ts`: `EDIT_FIELD_LABEL_MESSAGES`, (`ROLE_VARIANT` — done),
  `coerceDomain`, `AnyField`, `AnyForm`
- [todo] `ProjectEditFields` (+ константы выше как предпосылка) -> свой файл
- [todo] хук `useProjectPermissions(user, project)` (7 производных RBAC-флагов; риск-зона `canSeeProjectFinance`)
- [todo] хук `useProjectDropMutations`

Уровень 2 — нужен дизайн интерфейса (предпосылки: уровень 1):

- [todo] `ProjectEditDialog` (владеет `editForm`; риск: field-scoped RBAC в `onSubmit` — `paymentType`/override
  только при `canEditOverride`) <- `ProjectEditFields`, константы, `useProjectPermissions`
- [todo] диалоги remove-member / add-member / drop-picker / detach-drop
  <- `useProjectDropMutations`, `useProjectPermissions`
- [todo] overview-таб (вынос) <- `ProjectInfoRows`, `PendingShareApprovalBanner`, `ProjectEffectiveTeamCard`
- [todo] hero-хедер <- `ProjectHeaderApprovalNote`, `ProjectUnarchive*`

Риск-зоны: finance-маскирование (`canSeeProjectFinance`); порядок хуков до early-return
(Rules of Hooks); field-scoped RBAC в submit.

Цель <- все узлы выше.
