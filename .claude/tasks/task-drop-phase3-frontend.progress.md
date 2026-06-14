# task-drop-phase3-frontend progress

## Status: DONE

## current_milestone: 3/3

## last_commit: a713d51

## last_push: feature/drop-phase3-frontend

## files_done

- apps/api/src/users/users-access.service.ts — DROP self-view excludes 'projects' tab
- apps/api/src/users/users-access.service.spec.ts — 3 new DROP-specific tests (47 total)
- apps/web/app/routes/crm/team/index.tsx — DROP added to auto-redirect
- apps/web/app/components/user-profile/tabs/OverviewTab.tsx — RequisitesMissingBanner + DropRequisitesSnippet
- apps/web/app/components/user-profile/UserProfileShell.tsx — onGoToTab prop passed to OverviewTab
- apps/web/app/components/user-profile/tabs/FinanceTab.tsx — «Добавить приход» CTA removed
- apps/web/app/routes/crm/finance/components/DropFinancePage.tsx — ghost button in header
- apps/web/app/routes/crm/routing/components/DropQuickActions.tsx — unified testid drop-register-income-btn

## blast_radius

- users-access.service: isSelf branch — checked, DROP self now has dedicated branch. SENIOR/HR/ACCOUNTANT untouched.
- FinanceTab: removed isOwnDropProfile CTA + createOpen state + CreateTransactionDialog — only «Платить компании» rows remain
- OverviewTab: added onGoToTab? optional prop — zero blast radius (no existing callers use it)
- DropQuickActions: testid changed from drop-quick-register-btn → drop-register-income-btn — for AutoTest to update E2E specs

## ac_verified: 1,2,3,4,5
