# Module: Finance

## Status: ✅ Implemented (PHASE 5)

## Financial flow

```
SENIOR enters a transaction (PENDING)
→ ACCOUNTANT validates (VALIDATED)
→ SENIOR clicks "Pay" (PENDING_PAYMENT)
→ SENIOR pays 74% via a smart contract (Phase 8)
  ├── JUNIOR: a fixed amount (from project_finance_settings)
  └── The remainder: 50% ADMIN + 50% partner
→ SENIOR keeps 26% → status PAID
```

## RBAC

| Role       | Access                                          |
| ---------- | ----------------------------------------------- |
| ADMIN      | All transactions, all reports                   |
| ACCOUNTANT | All transactions, validation, expenses, payouts |
| SENIOR     | Only their own transactions and balance         |
| HR         | Their own salary payouts                        |
| JUNIOR     | ❌ No access to finance                         |

## Entities

- **transactions** — a SENIOR's income from a project (PENDING → VALIDATED → PENDING_PAYMENT → PAID / REJECTED)
- **expenses** — company expenses (ADMIN/ACCOUNTANT)
- **junior_payments** — payments to a JUNIOR for a project
- **invoices** + **invoice_transactions** — an invoice combines transactions (DRAFT → SIGNED / CANCELLED)
- **payouts** + **payout_transactions** — payouts to the partners MAKSYM/KOSTYA (PENDING_PAYMENT → PAID)

## Additional services

- **NBU rates** — a daily cron, currency rates from the NBU API
- **Etherscan** — verification of crypto transactions by hash (read-only)
- **PDF invoice** — generation via pdfkit

## Endpoints (key)

```
POST   /api/transactions                  → create (SENIOR)
PATCH  /api/transactions/:id/validate     → validate (ACCOUNTANT)
PATCH  /api/transactions/:id/reject       → reject (ACCOUNTANT)
POST   /api/transactions/:id/pay          → pay (SENIOR)
GET    /api/invoices/:id/pdf              → download PDF
POST   /api/payouts/:id/pay              → mark the payout as paid
```
