# Invoice Signing Epic — Master Spec

**Feature:** Automatic invoice generation + two-sided signing (company + counterparty) for two transaction types: Senior payout (74% of the company) + Employee salary (company → employee).

**Started:** 2026-05-26

## Business logic

### Invoice generation triggers

**1. Senior payout (74% to the smart contract):**

- SENIOR creates a SENIOR_INCOME transaction → ACCOUNTANT validates → SENIOR clicks "Pay"
- At the moment of a successful `POST /api/transactions/:id/submit-payment`:
  - A PDF is generated (only the COMPANY/ADMIN signature)
  - Auto-sign ADMIN (method=AUTO_COMPANY)
  - Notification SENIOR: "The invoice awaits your signature"

**2. Employee salary (company → JUNIOR/SENIOR/HR):**

- ADMIN/ACCOUNTANT creates a SALARY transaction → goes through the whole workflow → status=PAID
- At the moment of the status → PAID transition:
  - A PDF is generated
  - Auto-sign ADMIN
  - Notification employee: "The invoice awaits your signature"

### Invoice lifecycle

```
[Generated]
   ↓ auto-sign COMPANY
[Awaiting signature] ─┐
                      │ counterparty clicks "Sign"
                      │ → hash verify → insert COUNTERPARTY signature
                      │ → re-gen PDF with both signatures
                      │ → upload new Document, soft-delete old
                      │ → update transactions.invoice_document_id FK
                      ↓
              [Signed by all] (immutable)
```

**After SIGNED:** invoice immutable. If an edit is needed — an **amendment** is created (a new invoice with a ref to the old one via the `amends_transaction_id` field — out of scope for v1, deferred).

### Signing (Click + audit)

On clicking "Sign":

1. Backend downloads the current PDF from S3 → compute SHA-256 hash
2. Compare with the `pdf_hash` of the first signature (AUTO_COMPANY) → if mismatched → 409 Conflict (protection against tampering)
3. Insert an `invoice_signatures` row: `signer_role=COUNTERPARTY`, `signer_id=user.id`, `pdf_hash=current`, `ip_address=req.ip`, `user_agent=req.headers['user-agent']`, `method=MANUAL_CLICK`
4. Re-gen the PDF with both signatures (ADMIN name + timestamp, counterparty name + timestamp + short hash)
5. Upload the new PDF as a Document (category=INVOICE) → update `transactions.invoice_document_id` → soft-delete the old Document

**Legal significance:** a click-signature does NOT replace the KEP (qualified electronic signature, Ukraine), but is sufficient for internal accountability + audit.

## RBAC

| Action                               | ADMIN            | SENIOR  | JUNIOR  | HR      | ACCOUNTANT |
| ------------------------------------ | ---------------- | ------- | ------- | ------- | ---------- |
| Auto-sign COMPANY (system)           | ✓                | —       | —       | —       | —          |
| Sign as COUNTERPARTY (SENIOR_PAYOUT) | —                | ✓ (own) | —       | —       | —          |
| Sign as COUNTERPARTY (SALARY)        | —                | ✓ (own) | ✓ (own) | ✓ (own) | —          |
| View all invoices                    | ✓                | —       | —       | —       | ✓          |
| View own invoices                    | ✓                | ✓       | ✓       | ✓       | ✓          |
| Public verify endpoint (no auth)     | public read-only |         |         |         |            |

## DB Schema

### Migration 0016 — INVOICE category + FK

```sql
ALTER TYPE document_category ADD VALUE 'INVOICE';

ALTER TABLE transactions
  ADD COLUMN invoice_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;

CREATE INDEX idx_transactions_invoice ON transactions(invoice_document_id) WHERE invoice_document_id IS NOT NULL;
```

### Migration 0017 — invoice_signatures

```sql
CREATE TYPE invoice_signer_role AS ENUM ('COMPANY', 'COUNTERPARTY');
CREATE TYPE invoice_signature_method AS ENUM ('AUTO_COMPANY', 'MANUAL_CLICK');

CREATE TABLE invoice_signatures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  signer_role invoice_signer_role NOT NULL,
  signer_id UUID NOT NULL REFERENCES users(id),
  signed_at TIMESTAMP NOT NULL DEFAULT now(),
  pdf_hash CHAR(64) NOT NULL,
  ip_address INET,
  user_agent TEXT,
  method invoice_signature_method NOT NULL,
  CONSTRAINT uniq_sig UNIQUE (transaction_id, signer_role)
);

CREATE INDEX idx_invoice_signatures_transaction ON invoice_signatures(transaction_id);
CREATE INDEX idx_invoice_signatures_signer ON invoice_signatures(signer_id);
```

### Migration 0018 — notifications

```sql
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,         -- 'INVOICE_SIGN_REQUIRED', 'INVOICE_SIGNED'
  title VARCHAR(255) NOT NULL,
  body TEXT,
  link VARCHAR(500),                  -- '/crm/finance/invoices/:id'
  read_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;
CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at DESC);
```

## PDF Template

Contents (Russian language, A4 portrait):

1. **Header:** Company logo (`projects.logoDocId` reuse OR company logo from `/admin/settings` — out of scope v1) + the name "CheekyCheese IT"
2. **Title:** "АКТ ВЫПОЛНЕННЫХ РАБОТ" (for SENIOR_PAYOUT) or "ВЫПЛАТА ЗАРПЛАТЫ" (for SALARY)
3. **Side A — Company:**
   - Name: CheekyCheese IT
   - Address/Requisites: from constants (TBD) or from `.env`
4. **Side B — Counterparty:**
   - Full name (from `users.displayName` + optionally legal name from `legends` if present for a SENIOR)
   - Requisites: USDT ERC-20 wallet OR UAH bank account (depends on `users.preferredPaymentMethod` — added earlier in Phase 7)
5. **Body:**
   - Description: for SENIOR_PAYOUT → "Share for project {projectName}, period {salaryMonth}"; for SALARY → "Employee wage for {salaryMonth}"
   - Amount + currency (for example `1234.56 USDT`)
   - Equivalent in UAH (via the NBU rate if currency != UAH)
6. **Signatures block:**
   - **Signature 1 — Company:** ADMIN displayName, timestamp, method "Automatic (electronic)"
   - **Signature 2 — Counterparty:** displayName + timestamp + short hash (8 chars) + IP last octet (privacy) OR "Awaiting signature" if not yet signed
7. **Footer:** QR code → link `https://{FRONTEND_URL}/invoice/v/{transactionId}` for independent hash verification

### Verification endpoint (public, no auth)

`GET /api/invoices/:transactionId/verify` →

```json
{
  "transactionId": "uuid",
  "status": "SIGNED" | "PENDING",
  "amount": "1234.56",
  "currency": "USDT",
  "type": "SENIOR_INCOME" | "SALARY",
  "signatures": [
    { "role": "COMPANY", "signerName": "Maksym Y.", "signedAt": "2026-05-26T14:00:00Z", "pdfHashShort": "a1b2c3d4" },
    { "role": "COUNTERPARTY", "signerName": "John D.", "signedAt": "2026-05-26T15:30:00Z", "pdfHashShort": "a1b2c3d4" }
  ]
}
```

UI verification page `/invoice/v/:id` — public (no login), shows "✓ Document verified" + details.

## Notifications system

### Backend events

- `INVOICE_SIGN_REQUIRED` — the counterparty receives it after auto-sign COMPANY
- `INVOICE_SIGNED` — the ADMIN receives it after the counterparty signs (for tracking)

### UI Header bell

In PHASE 1 NotificationsContext was a front-end stub (in-memory). We extend:

- Backend `GET /api/notifications?unreadOnly=true&limit=10` (TanStack Query, polling 30s OR WebSocket — v1 uses polling)
- Backend `PATCH /api/notifications/:id/read`
- Backend `PATCH /api/notifications/read-all`
- Frontend: Badge with unread count, dropdown with the 10 latest, click on an item → mark read + navigate to link

## Endpoints (new)

```
GET    /api/invoices                              — list (by filters status/type/period)
GET    /api/invoices/:transactionId               — detail (transaction + document URL + signatures)
POST   /api/invoices/:transactionId/sign          — counterparty signing
GET    /api/invoices/:transactionId/verify        — PUBLIC (no auth) — hash + signatures for the QR

GET    /api/notifications?unreadOnly=true         — list
PATCH  /api/notifications/:id/read                — mark single
PATCH  /api/notifications/read-all                — mark all
```

Internal helper (called from `transactions.service.ts`):

```
InvoicesService.autoCreateInvoiceForPayout(transactionId)   — trigger 1
InvoicesService.autoCreateInvoiceForSalary(transactionId)   — trigger 2 (when status=PAID)
```

## UI

### New page `/crm/finance/invoices`

- Tabs: "Awaiting signature" (badge with count) / "Signed by all" / "All"
- Filter dropdown: type (Senior payout / Salary / All)
- Sorting: by creation date desc
- Card: type badge + amount + currency + counterparty (full name) + date + status
- Click → InvoiceDetailDialog

### InvoiceDetailDialog (modal)

- PDF preview (iframe or PDF.js)
- Signatures table: role, signer name, signed at, method (Auto/Manual)
- If viewer ≠ counterparty OR already signed: the "Sign" button is hidden
- "Sign" button (active only if viewer == counterparty AND there is no COUNTERPARTY signature):
  - Opens a confirm dialog: "I agree with the contents of the invoice" (checkbox) + "Sign"
  - Submit → spinner → success toast → close dialog → invalidate queries

### Header bell enhancement

- Badge with the number of unread (server-side count)
- Dropdown with the 10 latest
- Item: title + body preview + relative time ("2 minutes ago")
- Click on an item → mark read + navigate to link (`/crm/finance/invoices/:id`)
- "Read all" button at the bottom of the dropdown

### Public verification page `/invoice/v/:id`

- Fully without auth
- A big green "✓ Document verified"
- Signatures table: signer name + signed at
- PDF hash short (8 chars) for cross-check
- Transaction: type, amount, currency, date
- NO raw IP / user-agent / other private data

## Task decomposition (5 tasks)

| #   | Task                      | Depends on | Agent    | Branch                       |
| --- | ------------------------- | ---------- | -------- | ---------------------------- |
| 1   | `task-invoice-data-layer` | —          | Coder    | `feature/invoice-data-layer` |
| 2   | `task-invoice-pdf-gen`    | 1          | Coder    | `feature/invoice-pdf-gen`    |
| 3   | `task-invoice-api`        | 1, 2       | Coder    | `feature/invoice-api`        |
| 4   | `task-invoice-ui`         | 3          | Coder    | `feature/invoice-ui`         |
| 5   | `task-invoice-e2e`        | 4          | AutoTest | `tests/invoice-e2e`          |

**Dispatch strategy:** 4 rounds.

- **Round 1:** dispatch task 1 (data-layer)
- **Round 2:** after merge #1 — dispatch task 2 (pdf-gen) + task 3 (api) in parallel (task 3 waits for the task 2 PDF service stub, but the schema level is already ready)
- **Round 3:** after merge #2 + #3 — dispatch task 4 (ui)
- **Round 4:** after merge #4 — dispatch task 5 (e2e)

**Estimate:** ~7-8 hours of product code total. With review/testing — ~5-7 days to full merge.

## Out of scope for v1 (recorded for future iterations)

- ❌ KEP via Diia/Diia.app — a separate epic
- ❌ Cancellation/amendments — only via manual ADMIN intervention in the DB
- ❌ Partner payouts (MAKSYM/KOSTYA 50/50) — without an invoice for now
- ❌ Expense invoices — without a signature for now
- ❌ WebSocket for notifications — v1 polling 30s
- ❌ Email + Telegram notifications — only the in-app bell
- ❌ Multi-ADMIN auto-sign selection — hardcoded to a single ADMIN (if 2+ — the first by created_at is taken)

## Acceptance (PHASE-level)

- [ ] All 5 tasks merged
- [ ] Locally: create a SALARY transaction → status PAID → invoice auto-created → counterparty signed → status SIGNED → PDF re-generated
- [ ] Locally: SENIOR submits payout → invoice auto-created → SENIOR signed → SIGNED
- [ ] The bell in the Header shows the unread count + the dropdown with deep links works
- [ ] Public verify page `/invoice/v/:id` is accessible without login, shows correct signatures
- [ ] The QR code in the PDF leads to the public verify page
- [ ] E2E coverage: auto-create, sign, RBAC, hash mismatch error, verify endpoint
- [ ] No regressions: PHASE 6 documents tests still pass
