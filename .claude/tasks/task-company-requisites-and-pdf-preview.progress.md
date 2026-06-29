# Progress: feat/company-requisites-and-pdf-preview

current_milestone: 1/6
branch: feat/company-requisites-and-pdf-preview
last_commit: (pending)
last_push: (pending)

## Milestones

1. Part 1 backend — companyAccount.requisitesMarkdown (shared schema + drizzle + migration + service + controller + tests)
2. Part 2 — appendCompanyRequisitesSection helper + sign() append + tests
3. Part 3 backend — POST /contracts/templates/preview-pdf (tokens visible, requisites appended, unsigned mode) + tests
4. Part 3 frontend — rewire Предпросмотр button to PDF flow (PdfPreview) + editor layout test update
5. Part 4 frontend — «Компания» tab rename + Реквизиты компании editor card
6. Verify — typecheck/lint/test/build + Playwright screenshots 375/1440 + report

## blast_radius (existing exported symbols touched)

- renderContractTemplate (contract-rendering.ts:69) — 8 callers; behavior UNCHANGED (new helper is separate). Pinned by contract-rendering.spec.ts.
- generateContractPdf (contract-pdf.service.ts:173) — 8 callers; called in NEW preview mode (contractNumber='', signedTypedName='', verifyUrl=''). Native unsigned-preview support already exists (no signature change). Pinned by contract-pdf.service.spec.ts.
- getAccount (company-account.service.ts:73) — returns +requisitesMarkdown (additive field). CompanyAccountDto extended (additive). Pinned by company-account.service.spec.ts + rbac integration.
- sign (signed-contracts.service.ts:64) — appends requisites BEFORE storing snapshot; existing signed rows untouched.

## files_done

(none yet)

## files_pending

- packages/shared/src/schemas/finance.ts
- apps/api/src/database/schema.ts
- apps/api/src/database/migrations/\*.sql (generated)
- apps/api/src/finance/company-account.service.ts
- apps/api/src/finance/company-account.controller.ts
- apps/api/src/finance/company-account.service.spec.ts (+ rbac integration)
- apps/api/src/contracts/contract-rendering.ts
- apps/api/src/contracts/contract-rendering.spec.ts
- apps/api/src/contracts/signed-contracts.service.ts
- apps/api/src/contracts/contract-templates.controller.ts (+ preview-pdf)
- apps/api/src/contracts/contract-templates.controller.spec or integration
- apps/web/app/routes/\_authenticated/finance/api.ts
- apps/web/app/routes/\_authenticated/admin/route.tsx
- apps/web/app/routes/\_authenticated/admin/wallet.index.tsx
- apps/web/app/routes/\_authenticated/admin/contracts.$role.tsx
- apps/web/app/routes/\_authenticated/admin/**tests**/contracts-editor-layout.test.tsx
