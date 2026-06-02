# E2E Coverage Map

Audit produced by `task-autotest-business-logic-coverage` after Phase 4 +
Refactor (drop pays company, ТОВ removed) + Team senior-share override +
Aggregate invoice + Public verify endpoint.

Format per row: **Business area** — _existing spec(s) that cover it_ →
**Status** (✅ covered / ⚠️ partial / ❌ gap → spec to add).

## A. Drop role end-to-end

| Sub-area                                                                                                      | Spec                                                                                                                                  | Status                                  |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Create DROP via unified UserDialog                                                                            | `drop-create.spec.ts`                                                                                                                 | ✅                                      |
| Create DROP — duplicate email                                                                                 | `drop-duplicate-email.spec.ts`                                                                                                        | ✅                                      |
| Multi-HR drop create                                                                                          | `drop-multi-hr.spec.ts`                                                                                                               | ✅                                      |
| Sidebar / route visibility (AC8)                                                                              | `drop-rbac.spec.ts`                                                                                                                   | ✅                                      |
| Route guards (direct URL hits)                                                                                | `drop-route-guards.spec.ts`                                                                                                           | ✅                                      |
| Backend RBAC on /transactions, /finance/summary, /payout-requests                                             | `drop-backend-rbac-api.spec.ts`                                                                                                       | ✅                                      |
| Drop archive (cascade)                                                                                        | `drop-archive-cascade.spec.ts`, `drop-archive-real.spec.ts`, `drop-archive-user-real.spec.ts`, `drop-archive-impact-contract.spec.ts` | ✅                                      |
| DROP submits DROP_INCOME from /crm/profile                                                                    | `drop-income-ui.spec.ts`                                                                                                              | ✅                                      |
| Drop-project create via UI                                                                                    | `drop-project-create.spec.ts`                                                                                                         | ✅                                      |
| End-to-end smoke (HR creates drop-team → DROP logs in → posts income → ADMIN validates → cash flow → archive) | _gap_                                                                                                                                 | ❌ → **`drop-role-end-to-end.spec.ts`** |

## B. Phase 2 auto-50/50 cascade

| Sub-area                                                       | Spec                                                                                          | Status                                         |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Drop distribution math ($1000 → 950 / 50 / 345 / 345)          | `drop-distribution.spec.ts`                                                                   | ✅                                             |
| Drop distribution edge cases                                   | `drop-distribution-edge.spec.ts`                                                              | ✅                                             |
| Phase 2 cascade still works post-Phase 3                       | `phase2-auto-distribution-regression.spec.ts`                                                 | ✅                                             |
| Senior-project cascade — PAYOUT_ADMIN.projectId set            | `payout-admin-projectid-regression.spec.ts`, `senior-project-distribution-regression.spec.ts` | ✅                                             |
| SENIOR_INCOME → PAID → exactly 1 aggregated invoice per PAYOUT | _gap_                                                                                         | ❌ → **`payout-auto-cascade-invoice.spec.ts`** |

## C. Phase 3 manual confirmPayout

| Sub-area                                                                           | Spec                                    | Status                                          |
| ---------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------- |
| ADMIN confirms drop PAYOUT happy path                                              | `drop-confirm-payout.spec.ts`           | ✅                                              |
| ACCOUNTANT confirms senior PAYOUT happy path                                       | `senior-confirm-payout.spec.ts`         | ✅                                              |
| RBAC matrix on confirm-payout                                                      | `drop-confirm-payout-rbac.spec.ts`      | ✅                                              |
| Edge cases (already paid / wrong type / invalid recipient)                         | `drop-confirm-payout-edges.spec.ts`     | ✅                                              |
| **`method=CASH` vs `method=CRYPTO` radio behavior + DB `payment_method` snapshot** | _gap_ — existing specs always pick CASH | ❌ → **`payout-manual-confirm-method.spec.ts`** |

## D. Phase 4 Cash channel

| Sub-area                                                          | Spec  | Status                               |
| ----------------------------------------------------------------- | ----- | ------------------------------------ |
| ADMIN sees «Cash передан» on VALIDATED DROP_INCOME                | _gap_ | ❌ → **`drop-cash-channel.spec.ts`** |
| Submit → ADMIN_INCOME_CASH + SENIOR_PENDING_PAYOUT debtor=COMPANY | _gap_ | ❌ same spec                         |
| DROP forbidden (RBAC)                                             | _gap_ | ❌ same spec                         |
| Idempotency: second submit → 400                                  | _gap_ | ❌ same spec                         |

## E. Phase 4 Crypto channel

| Sub-area                                                                | Spec  | Status                                 |
| ----------------------------------------------------------------------- | ----- | -------------------------------------- |
| DROP on /crm/payments/initiate/:id sees crypto card only                | _gap_ | ❌ → **`drop-crypto-channel.spec.ts`** |
| Submit with 2 txHashes → 2× ADMIN_INCOME_CRYPTO + SENIOR_PENDING_PAYOUT | _gap_ | ❌ same spec                           |
| Validation — 0 txHashes → error                                         | _gap_ | ❌ same spec                           |

## F. Phase 4-C Pending settlement (debtor=COMPANY)

| Sub-area                                                    | Spec  | Status                                |
| ----------------------------------------------------------- | ----- | ------------------------------------- |
| GET /api/pending-settlements/senior + /company RBAC + shape | _gap_ | ❌ → **`pending-settlement.spec.ts`** |
| ADMIN settles COMPANY debt → SENIOR_INCOME + invoice        | _gap_ | ❌ same spec                          |
| DROP cannot see senior debts (RBAC)                         | _gap_ | ❌ same spec                          |

## G. Team senior-share override

| Sub-area                                                          | Spec                                     | Status                                 |
| ----------------------------------------------------------------- | ---------------------------------------- | -------------------------------------- |
| Project override (UI + snapshot in tx)                            | `projects-senior-share-override.spec.ts` | ✅                                     |
| Project override boundary + clamp + null logic                    | same                                     | ✅                                     |
| **Team-level override** (precedence: project > team > user)       | _gap_                                    | ❌ → **`team-share-override.spec.ts`** |
| Source badge on SENIOR_INCOME row (PROJECT / TEAM / USER_DEFAULT) | _gap_                                    | ❌ same spec                           |

## H. Aggregate invoice

| Sub-area                                                       | Spec  | Status                               |
| -------------------------------------------------------------- | ----- | ------------------------------------ |
| Single-project SENIOR_INCOME → 1 invoice generated             | _gap_ | ❌ → **`invoice-aggregate.spec.ts`** |
| Multi-project PAYOUT cascade → **1** aggregate invoice (not N) | _gap_ | ❌ same spec                         |
| Aggregate amount math matches sum of transactions              | _gap_ | ❌ same spec                         |

## I. Invoice signing flow

| Sub-area                                                 | Spec                                                 | Status                                  |
| -------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------- |
| Notification → InvoiceDetailDialog → sign                | `invoices-signing-flow.spec.ts` (mock-based, PR #56) | ⚠️ mock-based                           |
| Counterparty signs → real backend hash check + re-render | _gap_                                                | ❌ → **`invoice-signing-real.spec.ts`** |
| Hash mismatch on stale PDF → 409                         | _gap_                                                | ❌ same spec                            |

## J. Public verify endpoint

| Sub-area                                             | Spec                                         | Status                                   |
| ---------------------------------------------------- | -------------------------------------------- | ---------------------------------------- |
| /invoice/v/:txId UI states (success / pending / 404) | `invoices-signing-flow.spec.ts` C7-C9 (mock) | ⚠️ mock-based                            |
| GET /api/invoices/verify/:id without auth (real)     | _gap_                                        | ❌ → **`invoice-public-verify.spec.ts`** |
| Private fields stripped from response                | _gap_                                        | ❌ same spec                             |
| 404 → error                                          | _gap_                                        | ❌ same spec                             |

## K. RBAC matrix smoke

| Sub-area                                      | Spec  | Status                               |
| --------------------------------------------- | ----- | ------------------------------------ |
| `/api/balances/admin/:id`                     | _gap_ | ❌ → **`rbac-matrix-smoke.spec.ts`** |
| `/api/payments/confirm-cash`                  | _gap_ | ❌ same spec                         |
| `/api/pending-settlements/company`            | _gap_ | ❌ same spec                         |
| `/api/pending-settlements/:id/settle-company` | _gap_ | ❌ same spec                         |
| `/api/payments/initiate-crypto`               | _gap_ | ❌ same spec                         |

---

## Summary

- **Total existing spec files**: 57
- **Total existing tests**: ~600 (per `grep -c "  test\("`).
- **New spec files added in this PR**: 9 (see below).
- **Coverage growth (areas)**: D / E / F / G (team) / H / I (real) / J (real) / K from 0% → first-pass smoke.

### New specs to add

1. `drop-role-end-to-end.spec.ts` — A. Full DROP user journey integration smoke.
2. `payout-auto-cascade-invoice.spec.ts` — B. Phase 2 cascade → 1 aggregate invoice.
3. `payout-manual-confirm-method.spec.ts` — C. method=CASH vs CRYPTO radio + DB snapshot.
4. `drop-cash-channel.spec.ts` — D. Phase 4 cash flow.
5. `drop-crypto-channel.spec.ts` — E. Phase 4 crypto flow.
6. `pending-settlement.spec.ts` — F. Company debt list + settle.
7. `team-share-override.spec.ts` — G. Team-level senior share precedence.
8. `invoice-aggregate.spec.ts` — H. Aggregate invoice math + count.
9. `invoice-public-verify.spec.ts` — J. Public verify endpoint shape.
10. `rbac-matrix-smoke.spec.ts` — K. Cross-role HTTP probe matrix.
