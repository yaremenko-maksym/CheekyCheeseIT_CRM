# Plan: Per-Employee Contract Model (A3-1 Backend)

**Date:** 2026-06-04
**Branch:** feat/onboarding-ux-a3-1-backend
**PR:** A3-1 backend — employee_contracts + lifecycle + PDF refactor + JWT cleanup

---

## Problem

The original contract model (A1/A2a) was per-role: one active `contract_template` per role, user
signs by fetching the template live. This meant:

1. No per-employee customisation — every SENIOR signs the same template text.
2. Template edits after signing could create confusion (user signed v1, new user sees v2).
3. `isPreview` parameter in `ContractPdfService` was a leaky abstraction.
4. `legalFullName` in JWT cookie was a PII log-leak surface (MED #2).

## Solution

### DB layer

- New table `employee_contracts` with lifecycle enum `DRAFT | READY_TO_SIGN | SIGNED | CANCELLED`.
- Partial unique index: one non-CANCELLED row per user at all times.
- PostgreSQL trigger prevents ADMIN users from appearing as the employee.
- `signed_contract_id` FK links the employee_contract to its immutable audit row.

### Lifecycle

```
ADMIN creates user → lazy-create DRAFT employee_contract
ADMIN edits bodyMarkdown (per-employee customisation)
ADMIN marks READY_TO_SIGN
User calls POST /api/contracts/sign → SIGNED (bodyMarkdown snapshot captured)
ADMIN can revert SIGNED→DRAFT (re-opens onboarding, deletes ToS acceptances)
ADMIN can cancel (terminal, partial-unique allows a new active row)
ADMIN can reset body to current active template (DRAFT only)
```

### Services

- `EmployeeContractsService`: 10 methods covering the full lifecycle.
- `SignedContractsService.sign()`: refactored to read `employee_contract.bodyMarkdown` instead
  of fetching the role template directly. Calls `markSigned()` after INSERT.
- `ContractPdfService`: `isPreview` parameter removed; `signedTypedName.trim()` drives all
  conditional rendering (signature block, QR, contractNumber display).

### Endpoints

| Verb  | Path                           | Role  | Purpose                                     |
| ----- | ------------------------------ | ----- | ------------------------------------------- |
| GET   | /api/users/:id/contract        | ADMIN | Lazy-create or get active employee_contract |
| PATCH | /api/users/:id/contract        | ADMIN | Update body (DRAFT or READY_TO_SIGN)        |
| POST  | /api/users/:id/contract/ready  | ADMIN | DRAFT → READY_TO_SIGN                       |
| POST  | /api/users/:id/contract/revert | ADMIN | READY_TO_SIGN or SIGNED → DRAFT             |
| POST  | /api/users/:id/contract/reset  | ADMIN | Re-derive body from active template (DRAFT) |
| GET   | /api/users/:id/contract/pdf    | ADMIN | Render PDF (signed or preview)              |
| GET   | /api/onboarding/contract       | self  | Get own READY_TO_SIGN contract              |
| GET   | /api/onboarding/contract/pdf   | self  | Render unsigned PDF preview                 |

Removed: `GET /api/contracts/preview-pdf` (replaced by per-employee endpoints above).

### OnboardingGuard bypass

- Added: `/api/onboarding/contract` (prefix match covers both JSON + PDF routes).
- Removed: `/api/contracts/preview-pdf`.

### Shared schema

- `employee-contracts.ts`: `employeeContractStatusSchema`, `employeeContractSchema`,
  `updateEmployeeContractSchema`.
- `onboarding.ts`: `contractReady: z.boolean()` added to `onboardingStatusSchema`.
- `auth.ts`: `jwtPayloadSchema` (MED #2) — minimal `{id, email, role}` for JWT cookie.

### JWT cleanup (MED #2)

JWT cookie now stores only `{id, email, role}`. `legalFullName`, `displayName`, `avatarUrl`
are re-hydrated from DB on every `GET /api/auth/me` call. Cookie no longer contains plaintext
PII, eliminating the log-leak surface identified in security review #114.

### Seed backfill (AC9)

- 17 onboarded users → SIGNED `employee_contracts` linked to their `signed_contracts`.
- Dmytro Marchenko → READY_TO_SIGN (wizard test: ADMIN prepared contract, user hasn't signed).
- Ivan Petrenko → no `employee_contract` (completely un-onboarded fallback scenario).

## Milestones completed

| #   | Description                            | Files                                                                                                                 |
| --- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| M1  | Migration + schema.ts                  | `0001_employee_contracts.sql`, `schema.ts`                                                                            |
| M2  | EmployeeContractsService + tests       | `employee-contracts.service.ts`, `.spec.ts`                                                                           |
| M3  | Controllers + module + guard bypass    | `employee-contracts.controller.ts`, `onboarding-contract.controller.ts`, `contracts.module.ts`, `onboarding.guard.ts` |
| M4  | contractReady in OnboardingStatusDto   | `onboarding.ts` (shared), `onboarding.service.ts`, `.spec.ts`                                                         |
| M5  | ContractPdfService isPreview removal   | `contract-pdf.service.ts`, `.spec.ts`, `signed-contracts.controller.ts`                                               |
| M6  | SignedContractsService.sign() refactor | `signed-contracts.service.ts`, `.spec.ts`                                                                             |
| M7  | JWT minimal payload (MED #2)           | `auth.ts` (shared), `auth.controller.ts`, `auth.service.spec.ts`                                                      |
| M8  | Seed backfill employee_contracts       | `seed.ts`                                                                                                             |

## AC checklist

- [x] AC1 — Migration applied: `employee_contracts` table + enum + partial unique index + trigger
- [x] AC2 — Drizzle schema: `employeeContractStatusEnum` + `employeeContracts` table + relations
- [x] AC3 — `EmployeeContractsService` with full lifecycle (10 methods)
- [x] AC4 — `contractReady: boolean` in `OnboardingStatusDto` + `onboardingStatusSchema`
- [x] AC5 — `SignedContractsService.sign()` reads from `employee_contract` (not template)
- [x] AC6 — `ContractPdfService`: `isPreview` removed; `signedTypedName` drives conditionals
- [x] AC7 — `GET /api/onboarding/contract` + `/pdf`; `GET /api/users/:id/contract/pdf`
- [x] AC8 — MED #2: JWT payload minimal `{id,email,role}`; `/me` re-hydrates SessionUser
- [x] AC9 — Seed backfill: SIGNED employee_contracts + 1 READY_TO_SIGN (Dmytro) + 1 without
- [x] AC10 — 612 tests green (above 580+ threshold)
- [x] AC11 — This plan doc committed
- [x] AC12 — typecheck 4/4 + ESLint 0 errors
