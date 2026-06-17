# Progress: fix-contract-real-pdf-size

current_milestone: 2/2
last_commit: 789743b
last_push: pending

## Milestone 1 — seed fix (previous Coder, f1f1003)

- `apps/api/src/database/seed.ts` — real PDF generation instead of formula

## Milestone 2 — eager PDF size on sign() (this session)

- `apps/api/src/contracts/signed-contracts.service.ts`:
  - injected `ContractPdfService` (3rd ctor arg)
  - post-tx: `generateContractPdf` + `recordPdfSizeIfAbsent` outside tx
  - try/catch: PDF failure -> Logger.warn, sign() still resolves
- `apps/api/src/contracts/signed-contracts.service.spec.ts`:
  - added `makePdfSvc()` mock factory
  - all 18 `new SignedContractsService(...)` updated to 3 args
  - +2 tests: eager size recorded + PDF failure does not throw

blast_radius:

- SignedContractsService ctor: DI via NestJS module (ContractPdfService
  already in contracts.module providers — no module change needed)
- All 37 unit tests green

files_done:

- apps/api/src/contracts/signed-contracts.service.ts
- apps/api/src/contracts/signed-contracts.service.spec.ts

files_pending: none
