# Design Spec — Onboarding: Contract PDF Preview + Signature Simplification

**Slug:** `onboarding-contract-ux`
**Mode:** A — Design Direction (pre-feature)
**Status:** DRAFT — awaiting User decision on Pending Decisions (§7)
**Branch:** `claude/heuristic-payne-c95cdb`
**Date:** 2026-06-04

---

## 1. Direction (frontend-design-direction)

### 1.1 Purpose

A user (SENIOR / JUNIOR / HR / ACCOUNTANT / DROP) goes through the onboarding wizard.
The «Подписание контракта» step must:

1. Show a **formatted PDF document** instead of a raw markdown block — so that the user
   sees exactly what will go into the archive, including the emblem, number, signature block.
2. Allow **signing in one action** (checkbox + button) — without an extra name input
   field: the name is taken from the legal fields set by ADMIN when creating the account.
3. Preserve full **WCAG 2.2 AA** accessibility.

### 1.2 Audience

**Primary:** a non-ADMIN user on first login (goes through the wizard once).
**Secondary:** ADMIN when viewing the audit trail of signed contracts (`/crm/profile/audit`).

Frequency: the wizard — once for the whole time; audit — rare, on request.
Pattern: the user reads the document, makes sure the data is correct, presses «Подписать».

### 1.3 Tone

`Dense / quiet / scannable` — a SaaS tool. Not a landing, not an onboarding wizard in a playful style.

A contract is a legal document, the tone must be **serious, office-like**.
The wizard step looks like «an official document for review and signing»,
not like a «marketing feature reveal».

### 1.4 Memorable detail

**A single design idea:** the PDF viewer is embedded right in the wizard step, without extra iframe frames —
the user sees a real document with corporate branding (logo, number, date).
Under the viewer — a compact confirmation row: an avatar + a read-only name from the legal field + a checkbox + a button.
Signing feels like «I see specifically my document and confirm it».

### 1.5 Constraints

- Tailwind v4 + shadcn/ui. Only existing design tokens (`globals.css` `@theme inline`).
- Russian UI — all labels, errors, hints in Russian.
- WCAG 2.2 Level AA — target size ≥ 24×24, focus visible, contrast 4.5:1 / 3:1.
- Responsive: 320 / 768 / 1440px.
- No new npm packages > 50 KB gzip without explicit agreement (the PDF viewer budget).
- `apps/web/**` only — the Coder does not touch `apps/api/**` without a separate task.

---

## 2. PDF Preview in the Wizard

### 2.1 New API endpoint — preview-rendered PDF

**Problem:** the contract preview must be shown BEFORE signing. Currently only
`GET /api/contracts/:id/pdf` exists — downloading an already signed contract (requires `signedContractId`).

**A new endpoint is needed:** `GET /api/contracts/preview-pdf` (or `POST` with a role body).

**Critical:** this endpoint MUST be in the bypass list of `OnboardingGuard` (`onboarding.guard.ts`),
otherwise a user mid-onboarding will get 403. History: in the previous iteration's PR `preview-rendered`
failed with 403 precisely because of this.

**Preview endpoint implementation (for the Coder):**

```
GET /api/contracts/preview-pdf   (bypass-listed)
Auth: JWT required (the user is logged in, but not yet onboarded)
Response: application/pdf — stream

Logic:
1. Take the active template for user.role (as in `GET /api/contracts/templates/current/:role`)
2. Fill the placeholders via `SignedContractsService.interpolateVariables(template.body, user, new Date())`
   with the user's real data (the legal fields from §3)
3. Generate the PDF via ContractPdfService.generateContractPdf()
   With parameters:
     contractNumber: 'PREVIEW' (or localized: 'ПРЕДВАРИТЕЛЬНЫЙ ПРОСМОТР')
     signedTypedName: user.legalFullName (new field — §3) or fallback: '...'
     signedAt: new Date() (the current moment for the preview)
     signedIpLastOctet: null
     verifyUrl: '' (an empty string — the QR is not rendered in the preview)

Throttle: 5 req/min (the preview is more expensive than JSON)
```

**Add the bypass in `onboarding.guard.ts`:**

```typescript
private readonly bypassPrefixes = [
  '/api/auth/',
  '/api/onboarding/status',
  '/api/tos/current',
  '/api/tos/accept',
  '/api/contracts/templates/current/',
  '/api/contracts/sign',
  '/api/contracts/preview-pdf',  // NEW — preview before signing
]
```

### 2.2 Embedding method — options with pros/cons

#### Option A — `<iframe src="blob-url">` (recommended)

```tsx
// Frontend: fetch PDF → createObjectURL → set into the iframe src
const res = await api.get('/contracts/preview-pdf', { responseType: 'blob' })
const url = URL.createObjectURL(res.data)
// <iframe src={url} title="Предварительный просмотр контракта" />
```

**Pros:**

- The browser's native PDF rendering — no extra dependencies.
- Full control over scroll, zoom, print (the user sees exactly the document).
- The URL is released via `revokeObjectURL` on unmount.
- Safari, Chrome, Firefox — all support iframe + blob PDF.
- CSP-safe: a blob: URL does not violate the `frame-src 'self'` policy.

**Cons:**

- On mobile (iOS Safari) an iframe with a PDF sometimes does not embed, showing a download button.
  Fix: detect iOS → fall back to option C.
- No custom loading skeleton — the iframe shows an empty rectangle while the PDF loads.
  Fix: show `<Skeleton />` over the iframe until the `load` event fires.

#### Option B — PDF.js (`pdfjs-dist`)

**Pros:**

- Full control over rendering, a custom UI on top (page numbers, zoom controls).
- Stable cross-platform (including iOS).

**Cons:**

- Dependency: `pdfjs-dist` ≈ 260 KB gzip. Critically violates the 300 KB budget for App pages.
- Needs a `workerSrc` config — extra Vite setup (may conflict with the Vite 6 pin).
- Excessive complexity for a wizard step (a one-time read).

**Conclusion: NOT recommended** for this use case.

#### Option C — `<object data="blob-url" type="application/pdf">`

```tsx
<object data={blobUrl} type="application/pdf" width="100%" height="480">
  <p>
    Браузер не поддерживает встроенный просмотр PDF.
    <a href={blobUrl} download>
      Скачать контракт
    </a>
  </p>
</object>
```

**Pros:**

- Semantically correct (an embedded object).
- Fallback content inside `<object>` for browsers without PDF support.
- iOS Safari renders `<object type="application/pdf">` better than an iframe.

**Cons:**

- Accessibility: a screen reader does not read the PDF contents via `<object>`.
  Requires an aria-label + a text fallback.
- Behavior differs slightly from an iframe between browsers (Chrome / Firefox / Safari).

**Recommendation:** option A (iframe + blob) as the primary + option C as the iOS fallback.
iOS detection: `navigator.platform.includes('iPhone') || navigator.userAgent.includes('iPhone')`.

### 2.3 PDF viewer layout in the wizard step

```
┌─────────────────────────────────────────────────────────────────┐
│ [FileText icon] Ваш контракт                       [Badge: PREVIEW] │
│ Ознакомьтесь с документом перед подписанием                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │                                                           │   │
│  │          [Skeleton overlay or iframe PDF]                │   │
│  │              height: 480px desktop / 360px mobile         │   │
│  │                                                           │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                   │
│  [Alert info] Данные в контракте: имя, email, реквизиты —        │
│  задаются администратором. При ошибке обратитесь к ADMIN.        │
│                                                                   │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────┐   │
│  │ [checkbox]  Подтверждаю что ознакомился с MSA-контрактом │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                   │
│  [Avatar initials]  Дмитро Марченко                              │
│  Подпись — имя из admin-полей (read-only)                        │
│                                                                   │
│  [ Подписать контракт ← primary button, full-width ]             │
└─────────────────────────────────────────────────────────────────┘
```

**Responsive:**

- **1440:** viewer height 520px, wizard max-width `max-w-2xl`.
- **768:** viewer height 480px, wizard max-width `max-w-xl`.
- **320:** viewer height 340px. On iOS → `<object>` or a download-link fallback.

**Loading state (before the PDF blob loads):**

```tsx
// Skeleton over the iframe zone
<div
  className="relative w-full rounded-md border border-border bg-muted/20"
  style={{ height: '480px' }}
>
  {isLoadingPdf && (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-md bg-muted/30">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">Загрузка контракта...</p>
    </div>
  )}
  {blobUrl && (
    <iframe
      src={blobUrl}
      title="Предварительный просмотр контракта"
      className={cn('w-full h-full rounded-md border-0', isLoadingPdf && 'invisible')}
      onLoad={() => setIsLoadingPdf(false)}
      aria-label="Предварительный просмотр MSA-контракта"
    />
  )}
</div>
```

**Error state (the PDF endpoint failed):**

```tsx
// If the fetch finished with an error — show a fallback block
<div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
  <AlertTriangle className="inline h-4 w-4 mr-2" />
  Не удалось загрузить предварительный просмотр контракта. Обратитесь к администратору.
</div>
```

**Empty state (no template found for the role):**

- Backend `GET /api/contracts/templates/current/:role` returned 404 → the preview endpoint returns 404.
- Show the same component as the current one in `SignContractStep` on `!template`:
  a `FileText` icon + «Шаблон контракта для вашей роли не найден. Обратитесь к администратору.»

### 2.4 Consistency with the audit trail

`/crm/profile/audit` — there the user downloads the signed PDF via
`GET /api/contracts/:id/pdf`. This endpoint already exists and works (PR #108).

Additionally: consider adding an **inline preview** on the audit page (Pending Decision #2).

---

## 3. Admin legal fields (a new section in UserDialog)

### 3.1 Problem

`users.displayName` = "Dmytro Marchenko" (English, from Google OAuth).
In a legal contract (MSA) what is needed is: the full name in Cyrillic in the order Surname Name Patronymic.

In `interpolateVariables()` currently: `employeeName: user.displayName ?? 'не указано'` — WRONG.

### 3.2 New field in the `users` schema

**One new field** is needed:

```typescript
// apps/api/src/database/schema.ts — add to the users table:
legalFullName: text('legal_full_name'),
// Legal full name (Cyrillic, order: Surname Name Patronymic).
// Set by ADMIN on create/edit.
// Used in the contract instead of displayName.
// NULL = not set → interpolateVariables returns 'не указано'.
```

**Why one field and not three (firstName/lastName/patronymic):**

- In legal text the full name is always used as a whole.
- Splitting into parts is not needed for the contract.
- The admin knows the full order (full name or initials + Surname — enters as needed).
- Simpler validation: `min(5, 'ФИО минимум 5 символов')`.

**Bank requisites / USDT wallet:** the fields already exist (`walletUsdtErc20`, `bankUahRecipient`,
`bankUahIban`, `bankUahRnokpp`, `bankUahBankName`). Do not duplicate.

### 3.3 Drizzle migration

```sql
-- New migration (the next number after 0027):
ALTER TABLE users ADD COLUMN legal_full_name TEXT;
COMMENT ON COLUMN users.legal_full_name IS
  'Legal full name (Cyrillic, order: Surname First Patronymic). Set by ADMIN.';
```

The Drizzle schema already includes the payment requisites fields — only `legal_full_name` is added.

### 3.4 Form in UserDialog.tsx — a new «Данные для контракта» section

A new Section is added **after Section 1 (Идентичность)** and **before Section 2 (Контакты)**.
Visibility: show for all roles except ADMIN (ADMIN does not sign a contract).

```
┌─ Section: Данные для контракта ─────────────────────────────────┐
│  Информация для MSA-контракта. Задаётся администратором.         │
│  Используется в юридическом документе (не для отображения в UI). │
│                                                                   │
│  Field: Юридическое ФИО                     [required for signing] │
│  Placeholder: «Марченко Дмитро Олексійович»                      │
│  Hint: Кириллица, порядок: Фамилия Имя Отчество (Cyrillic, order: Surname Name Patronymic)                  │
│  Validation: min 5 characters, max 200                             │
│  data-testid: "user-dialog-legal-full-name"                      │
└─────────────────────────────────────────────────────────────────┘
```

**Add to the form's `defaultValues`:**

```typescript
legalFullName: editingUser?.legalFullName ?? '',
```

**In the create payload (CreateUserDto) / update payload (AdminUpdateUserDto):**

```typescript
legalFullName: value.legalFullName.trim() || undefined,
```

**Shared schema update** (`packages/shared/src/schemas/users.ts`):

```typescript
// Add to createUserSchema and adminUpdateUserSchema:
legalFullName: z.string().min(5).max(200).optional(),
// Add to userSchema (UserProfileDto):
legalFullName: z.string().nullable().optional(),
```

### 3.5 Updating interpolateVariables

```typescript
// signed-contracts.service.ts — interpolateVariables():
// WAS:
employeeName: user.displayName ?? 'не указано',

// BECOMES:
employeeName: user.legalFullName?.trim() || user.displayName || 'не указано',
// Fallback chain: legal full name → displayName (platform name) → 'не указано'
// The fallback via displayName preserves backward compatibility for old rows without legalFullName.
```

**The User type in the `interpolateVariables` pick:**

```typescript
static interpolateVariables(
  bodyMarkdown: string,
  user: Pick<
    User,
    | 'displayName'
    | 'legalFullName'  // ADD
    | 'email'
    | 'role'
    | 'walletUsdtErc20'
    | 'walletUsdtLabel'
    | 'bankUahRecipient'
    | 'bankUahIban'
    | 'bankUahRnokpp'
    | 'bankUahBankName'
    | 'paymentMethod'
  >,
  signedAt: Date,
)
```

---

## 4. Signing simplification (SignContractStep.tsx)

### 4.1 Remove the typed-name input

The `<Input placeholder="Ваше полное имя" />` field and the related `nameError` state — remove.

**What replaces it:**

Under the PDF viewer zone add a **read-only signature identification block**:

```tsx
<div className="flex items-center gap-3 rounded-md border border-border bg-muted/20 px-4 py-3">
  {/* Avatar with initials */}
  <Avatar className="h-8 w-8 shrink-0">
    <AvatarFallback className="text-xs">
      {getInitials(user.legalFullName ?? user.displayName)}
    </AvatarFallback>
  </Avatar>
  <div className="min-w-0 flex-1">
    <p className="text-sm font-medium leading-none truncate">
      {user.legalFullName || user.displayName}
    </p>
    <p className="text-xs text-muted-foreground mt-1">Подпись — юридическое ФИО из профиля</p>
  </div>
</div>
```

**If `legalFullName` is not filled (guard, §6):**
Show `<Alert variant="destructive">` + block the «Подписать» button.

### 4.2 Updating the submit flow

```typescript
// WAS: signMutation.mutate({ typedName })
// BECOMES:
signMutation.mutate() // empty body, or: { typedName: '' }
```

**Changes in the shared schema:**

`signContractSchema` (`packages/shared/src/schemas/contracts.ts`):

```typescript
// WAS:
export const signContractSchema = z.object({
  typedName: z.string().min(1, 'Введите ваше имя').max(200),
})

// BECOMES:
export const signContractSchema = z.object({
  // typedName is optional — the backend takes it from legalFullName
  typedName: z.string().max(200).optional(),
})
```

### 4.3 What happens to `signed_contracts.signedTypedName`

`signedTypedName text NOT NULL` — the field exists in the DB schema.

**Recommended approach (the Coder must decide):**

Option A — Fill from `legalFullName` server-side:

```typescript
// signed-contracts.service.ts, sign():
signedTypedName: user.legalFullName?.trim() || user.displayName || '',
// The audit trail keeps the name that was in the profile at the moment of signing.
// The column does not change in the schema — NOT NULL is preserved.
```

Option B — Rename the semantics: `signedTypedName` → stores the resolved legal name.
Requires a migration to change the comment in the DB (data stays).

**Recommendation: Option A** — no migration, backward compatible, the audit trail is preserved.
`variablesFilled.employeeName` in the JSONB will also update since `interpolateVariables` is updated.

### 4.4 New SignContractStep UI

**Final layout (after the changes):**

```
[FileText] Ваш контракт

┌────────────────────────────────────┐
│     iframe PDF preview (520px)     │
│     loading skeleton overlay       │
└────────────────────────────────────┘

[info alert] Данные задаются администратором...

[checkbox label]
┌─────────────────────────────────────────────────────────────┐
│ [ ] Я ознакомился и подтверждаю условия MSA-контракта       │
└─────────────────────────────────────────────────────────────┘

[signature block — read-only]
┌─────────────────────────────────────────────────────────────┐
│ [DM]  Марченко Дмитро Олексійович                           │
│       Подпись — юридическое ФИО из профиля                  │
└─────────────────────────────────────────────────────────────┘

[ Подписать контракт ]  ← disabled while !confirmed || !blobUrl || legalNameMissing
```

**State variables (simplified, without typed-name):**

```typescript
const [confirmed, setConfirmed] = useState(false)
const [blobUrl, setBlobUrl] = useState<string | null>(null)
const [isLoadingPdf, setIsLoadingPdf] = useState(true)
const [pdfError, setPdfError] = useState(false)
```

---

## 5. Accessibility (WCAG 2.2 AA critical paths)

### 5.1 Focus order in the wizard step

```
1. Heading "Ваш контракт" (h3 or a role in the stepper)
2. PDF viewer iframe — focusable (tabIndex=0), title="Предварительный просмотр контракта"
3. Info alert (if present)
4. Checkbox "Я ознакомился" — natively focusable
5. Signature block (read-only, role="group", aria-label="Подписант")
6. Button "Подписать контракт"
```

### 5.2 Target sizes

| Element                   | Current (estimate)      | SC 2.5.8 requirement | Fix                                               |
| ------------------------- | ----------------------- | -------------------- | ------------------------------------------------- |
| Checkbox `h-4 w-4` (16px) | 16×16px                 | 24×24px              | `min-h-6 min-w-6` (24px)                          |
| The «Подписать» button    | full-width, h-10 (40px) | OK                   | No change                                         |
| Info alert link «к ADMIN» | inline text             | 24px height          | Wrap in a `<button>` or make an `<a>` with `py-1` |

### 5.3 Contrast

The existing design tokens `--foreground` / `--muted-foreground` are already vetted in the system.
New elements:

- Signature block text: `text-sm font-medium` on `bg-muted/20` → token `foreground` on a `muted` bg.
  Light mode: `oklch(0.12 0 0)` on `oklch(0.94 0 0)` ≈ 8:1. OK.
  Dark mode: `oklch(0.97 0 0)` on `oklch(0.16 0 0)` ≈ 12:1. OK.
- Muted hint text `text-xs text-muted-foreground` on `bg-muted/20`:
  Light: `oklch(0.50)` on `oklch(0.94)` ≈ 3.8:1. Borderline — this is small text, 4.5:1 is needed.
  **Fix:** use `text-muted-foreground` directly without the `/20 overlay`, or raise to
  `oklch(0.40)` in light mode for the hint text. Or make the hint 14px (not small text).

- Skeleton overlay `bg-muted/30` with loading text: `text-muted-foreground` — OK.

### 5.4 Screen-reader fallback for the PDF viewer

An `<iframe>` with a PDF is not accessible to screen readers. Add `aria-describedby`:

```tsx
<div role="region" aria-label="Контракт для подписания">
  <iframe
    src={blobUrl}
    title="Предварительный просмотр MSA-контракта"
    aria-label="Предварительный просмотр MSA-контракта"
  />
  <p id="pdf-sr-note" className="sr-only">
    PDF-документ. При необходимости используйте кнопку «Скачать» ниже для просмотра контракта во
    внешней программе.
  </p>
</div>
```

Add a button / link «Скачать для просмотра» (only when `blobUrl` exists):

```tsx
<a
  href={blobUrl}
  download="contract-preview.pdf"
  className="text-xs underline text-muted-foreground"
>
  Скачать для просмотра
</a>
```

### 5.5 Checkbox accessibility

A native `<input type="checkbox">` — keep (do not replace with Radix). Currently `AcceptTosStep`
and `SignContractStep` use `<input type="checkbox" class="h-4 w-4 accent-primary">`.

Fix for SC 2.5.8: `className="mt-0.5 h-6 w-6 accent-primary"` (24×24px).

### 5.6 Modal/wizard a11y

The wizard renders in a fullscreen overlay. Check:

- `aria-modal="true"` on the wizard's root container.
- A focus trap on open (the first interactive element — a button or checkbox).
- Escape does not close the wizard (the user MUST complete onboarding) — make sure
  `onOpenChange` does not handle `Escape` in the wizard container.

---

## 6. Edge Cases & Guards

### 6.1 If `legalFullName` is not filled

ADMIN could have created a user before the new field was introduced (migration backward compat).

**Behavior:**

```
├─ [Alert variant="warning" inside signature block]
│    "Юридическое ФИО не заполнено администратором.
│     Подписание контракта невозможно.
│     Обратитесь к администратору для заполнения данных."
│
└─ Кнопка «Подписать» — disabled (не только из-за checkbox, но из-за отсутствия ФИО)
   cursor-not-allowed, aria-disabled="true"
   Tooltip: "Заполните юридическое ФИО в профиле (обратитесь к администратору)"
```

**Backend guard (additional protection):** `sign()` in `SignedContractsService` checks
`!user.legalFullName?.trim()` → `BadRequestException('LEGAL_NAME_REQUIRED')`.

The frontend handles this in `onError`:

```typescript
if (message.includes('LEGAL_NAME_REQUIRED')) {
  toast.error('Юридическое ФИО не заполнено. Обратитесь к администратору.')
  return
}
```

### 6.2 If the contract template does not exist for the role

Currently: `FileText icon + "Шаблон не найден"` is shown. Keep this behavior.
Preview endpoint: `GET /api/contracts/preview-pdf` returns 404 → the frontend shows an error state.

### 6.3 The PDF failed to load (network error, timeout)

Show the error state (§2.3) + a «Повторить загрузку» button (retry via invalidateQuery or
a repeated fetch).

### 6.4 The user has already signed (idempotency)

Backend `sign()` is already idempotent (returns the existing one if present). The frontend does not change.
The wizard step must not be shown if `onboarding-status` says `requiresContract: false`.

### 6.5 Mobile (iOS Safari) — the iframe does not render the PDF

```typescript
const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent)

// If iOS — do not use an iframe, show <object> or a download fallback
{isIos ? (
  <div className="rounded-md border border-border bg-muted/10 p-6 text-center space-y-3">
    <FileText className="h-10 w-10 text-muted-foreground mx-auto" />
    <p className="text-sm text-muted-foreground">
      Встроенный просмотр PDF недоступен на вашем устройстве.
    </p>
    <a href={blobUrl} download="contract-preview.pdf">
      <Button variant="outline" size="sm">Скачать контракт для просмотра</Button>
    </a>
  </div>
) : (
  <iframe src={blobUrl} ... />
)}
```

---

## 7. Pending Decisions (for the User to choose)

### PD-1 — The PDF embed method on mobile (iOS)

**Context:** an iframe + blob-URL works well on desktop. iOS Safari — unstable.

**Option A (recommended):** Detect iOS → show a download-link fallback instead of the iframe.
The user opens the PDF in an external app (Files/Adobe), returns to the browser, signs.

- Pros: zero dependencies, 100% reliability.
- Cons: the flow is interrupted (the user leaves the browser).

**Option B:** `<object type="application/pdf">` as a fallback inside the `<iframe>`.

```html
<iframe src="...">
  <object data="..." type="application/pdf">
    <a href="...">Скачать</a>
  </object>
</iframe>
```

- Pros: Progressive enhancement, without JS detects.
- Cons: Behavior in iOS is unpredictable, the object may still fail to render.

**Option C:** Do not decide now — the wizard is used inside the company (non-mobile contexts).
Show the iframe without an iOS fix, always add a «Скачать» button.

---

### PD-2 — Inline PDF preview on the audit page (`/crm/profile/audit`)

**Context:** Currently the audit trail has a «Скачать PDF» button (`GET /api/contracts/:id/pdf`).
After the changes in the wizard — should an inline preview be added there too?

**Option A:** Keep only the download. Audit is a rare action, a popup/download is enough.

- Pros: zero changes in the audit UI.
- Cons: Inconsistent — the wizard shows inline, audit — only a download.

**Option B:** Add an «Открыть» button next to «Скачать» — opens the PDF in a new tab
(`/api/contracts/:id/pdf` with `Content-Disposition: inline`).

- Pros: Consistent with the wizard UX.
- Cons: Requires adding a second Content-Disposition mode to the endpoint (a `?view=1` query param).

**Option C (recommended for audit):** In the audit card add an inline iframe/object
in an expandable accordion (collapsed by default). Click → expand → the PDF loads.

- Pros: Consistent, does not change the backend (the same `/pdf` endpoint, a blob in an iframe).
- Cons: Extra work in the audit UI.

---

### PD-3 — What to show in the preview-PDF signature block (preview watermark)

**Context:** The preview PDF is generated with `contractNumber: 'PREVIEW'` and `signedAt: new Date()`.
The signature block will look as if the contract were already signed.

**Option A (recommended):** Add a watermark «ПРЕДВАРИТЕЛЬНЫЙ ПРОСМОТР» to the PDF (red diagonal text over the pages).
Requires changing `ContractPdfService.generateContractPdf()` — an optional `isPreview: boolean` param.

- Pros: It is clearly visible that this is a preview, not the final document.
- Cons: Complicates the PDF generation service.

**Option B:** Do not add a watermark. In the signature block write the user's name,
the date «today» and a tooltip «это предварительный просмотр».
A `[PREVIEW]` badge in the wizard UI above the viewer — is enough.

- Pros: No changes in the PDF service.
- Cons: The PDF looks like a final document with today's date.

**Option C:** Remove the signature block from the preview PDF entirely.
The preview generates a PDF without the bottom signature block and QR.

- Pros: Fundamentally different from the signed PDF.
- Cons: A deeper change in the PDF service — a «preview mode» without a footer is needed.

---

### PD-4 — When to show the warning about a missing `legalFullName`

**Context:** ADMIN could have created a user before the field appeared. The migration adds `NULL`.

**Option A (recommended):** Block signing right when the wizard step loads.
An Alert warning + a disabled button + the tooltip «Обратитесь к администратору».

- Pros: Clear UX — the user knows why they cannot sign.
- Cons: Frustration if the admin simply does not know the new field needs filling.

**Option B:** Allow signing with a fallback to `displayName` (as before).
After the transition — in the JSONB `variablesFilled.employeeName` the platform name will be saved.
The admin can fix it via a new admin tool in the future.

- Pros: Zero friction for the user, backward compat.
- Cons: A contract with a legally incorrect name (en → cyr).

**Option C:** Show a warning (do not block), allow signing.
Next to the signature block: «Юридическое ФИО не задано, будет использован платформенный профиль».

- Pros: A compromise — the user sees the problem but is not blocked.
- Cons: Creates legally ambiguous documents.

---

## 8. Components used

All from the existing shadcn/ui `apps/web/app/components/ui/`:

| Component                                     | Why                                           |
| --------------------------------------------- | --------------------------------------------- |
| `Avatar`, `AvatarFallback`                    | The signer's initials in the signature block  |
| `Button`                                      | «Подписать контракт», «Скачать для просмотра» |
| `Skeleton`                                    | Loading overlay over the PDF viewer           |
| `Loader2` (lucide)                            | Spinner in the loading state                  |
| `Alert` (if exists) / `div` with a border     | Warning about a missing legalFullName         |
| `ScrollArea`                                  | NOT needed — replaced by the iframe PDF       |
| `Checkbox` / native `<input type="checkbox">` | Confirmation of having read                   |
| `Tooltip`                                     | Disabled button hint                          |
| `Badge`                                       | PREVIEW badge above the viewer                |

**New components: NOT needed.** Everything is built from the existing ones.

---

## 9. Token map

All existing tokens — from `globals.css` `@theme inline {}`. New ones are not needed.

| Token                                        | Where used                                               |
| -------------------------------------------- | -------------------------------------------------------- |
| `--color-border`                             | Frame of the PDF viewer, signature block, checkbox label |
| `--color-muted` / `--color-muted-foreground` | Loading overlay, hint text, error state                  |
| `--color-primary`                            | The «Подписать» button, checkbox accent                  |
| `--color-destructive`                        | PDF viewer error state, legalFullName missing alert      |
| `--color-card`, `--color-card-foreground`    | Signature block background if not muted                  |
| `--radius-lg` (0.625rem)                     | PDF viewer container, signature block                    |

---

## 10. Motion spec

Minimal motion (a contract is a serious context):

- The PDF viewer appears via `opacity: 0 → 1` (200ms, `ease-out`) when the blob is loaded.
  The skeleton leaves via opacity 0 (150ms).
- The «Подписать» button — no extra animations (there is already an `isPending` spinner via Loader2).
- Signature block — no animation. A static block.

```css
/* apps/web/app/styles/globals.css already has transition helpers via tw-animate-css */
/* Use: transition-opacity duration-200 ease-out */
```

---

## 11. Data flow summary (for the Coder)

```
UserDialog (ADMIN) → PATCH /api/users/:id { legalFullName: "Марченко Дмитро" }
                          ↓
                    users.legal_full_name = "Марченко Дмитро"

SignContractStep (frontend, wizard)
  → GET /api/contracts/preview-pdf  [bypass-listed]
  ← application/pdf stream (blob)
  → URL.createObjectURL(blob) → iframe src
  → user reads PDF
  → user checks checkbox
  → POST /api/contracts/sign  { typedName: "" }  [bypass-listed — already exists]
        ↓
    sign() resolves user.legalFullName → signedTypedName
    interpolateVariables(): employeeName = legalFullName || displayName
    INSERT signed_contracts (signedTypedName = legalFullName)
  ← 201 { contractNumber: "CHK-N-2026" }

/crm/profile/audit
  → GET /api/contracts/me
  → GET /api/contracts/:id/pdf  [download signed contract]
```

---

## 12. What does NOT change

- Contract templates (ADMIN-editable in `/crm/admin/templates/contracts`).
- `AcceptTosStep.tsx` — the ToS preview stays markdown (acceptable for ToS).
- `TosUpdateBanner.tsx` — unchanged.
- The `OnboardingGuard` bypass list — only `/api/contracts/preview-pdf` is added.
- Audit-trail immutability: `signedContracts.bodyMarkdownSnapshot` + `variablesFilled` — not touched.
- `contract_number_seq` — not touched.
- The PDF layout (emblem, number, separator, QR) — already good (PR #108). Do not redo.

---

## 13. Coder handoff checklist

**Backend (apps/api):**

- [ ] Migration: `ALTER TABLE users ADD COLUMN legal_full_name TEXT`
- [ ] Update the Drizzle schema `users` — add the `legalFullName` field
- [ ] Update `signed-contracts.service.ts`:
  - `interpolateVariables()` — `employeeName: legalFullName || displayName || 'не указано'`
  - `sign()` — `signedTypedName: legalFullName || displayName || ''`
  - Guard: if `!legalFullName.trim()` → `BadRequestException('LEGAL_NAME_REQUIRED')` (if PD-4 = Option A)
- [ ] New endpoint: `GET /api/contracts/preview-pdf` (bypass-listed, auth required)
  - Generates the PDF with `contractNumber: 'PREVIEW'` (or a watermark — pending PD-3)
  - Throttle 5 req/min
- [ ] Update `OnboardingGuard.bypassPrefixes` — add `/api/contracts/preview-pdf`
- [ ] Update `UsersService` + the Users controller — support `legalFullName` in PATCH/POST

**Shared (packages/shared):**

- [ ] `schemas/users.ts` — add `legalFullName` to `userSchema`, `createUserSchema`, `adminUpdateUserSchema`
- [ ] `schemas/contracts.ts` — `signContractSchema.typedName` → optional

**Frontend (apps/web):**

- [ ] `UserDialog.tsx` — add the «Данные для контракта» section with the `legalFullName` field
- [ ] `SignContractStep.tsx` — refactor:
  - Remove the typed-name input + `nameError` state
  - Add the PDF viewer (iframe + blob-URL + loading skeleton)
  - Add the signature block (avatar + legalFullName read-only)
  - Add a guard for a missing legalFullName (pending PD-4)
  - Add the iOS fallback (pending PD-1)
  - Add a download link for a11y

---

## 14. Additions from the User (2026-06-04) — in scope of PR A

### 14.1 Remove the sidebar (and header) from onboarding

**Problem:** the onboarding route `/crm/onboarding` is nested under the `/crm` layout (`apps/web/app/routes/crm/route.tsx`),
which always renders `<header>` + `<NavSidebar>` + the ambient background. So during onboarding the
sidebar and header are visible, although `crm/onboarding/route.tsx` itself is already a full-screen card.

**Fix (Coder, PR A):** in `CrmLayout` (`apps/web/app/routes/crm/route.tsx`) after the auth checks —
an early `return <Outlet />` when `location.pathname.startsWith('/crm/onboarding')` (onboarding provides its own
full-screen layout). The variable `onOnboardingRoute` is already computed inside the useEffect (line ~69) —
lift it into the component scope. Do not render the header / NavSidebar / background blobs on the onboarding route.

**Verify:** dev-login an un-onboarded SENIOR (`dmytro.marchenko@cheekycheese.dev`) → `/crm/onboarding`
without the sidebar and header (Manual QA screenshot 320/768/1440).

### 14.2 Add DROP to Dev Login

**Where:** `apps/web/app/routes/crm_/login.tsx`, the `DEV_USERS` array (hard-coded, line ~41) — currently there is no DROP.
Add an entry with the email of one of the DROP users that PR B will seed (take a stable known email
from the new seed after PR B merges). Label format `«<Name> — DROP»`.

> Dependency: the DROP user's email is fixed in PR B (seed). PM will pass the specific email into the PR A task
> after PR B merges.

## References

- `apps/api/src/contracts/signed-contracts.service.ts` — `interpolateVariables()`
- `apps/api/src/contracts/contract-pdf.service.ts` — `generateContractPdf()`
- `apps/api/src/common/pdf/pdf.constants.ts` — `PDF_BRAND`, `PDF_LAYOUT`, `PDF_COLORS`
- `apps/api/src/auth/onboarding.guard.ts` — bypass list
- `apps/web/app/components/onboarding/SignContractStep.tsx` — the component to refactor
- `apps/web/app/components/users/UserDialog.tsx` — the user create/edit form
- `apps/web/app/styles/globals.css` — design tokens
- `packages/shared/src/schemas/contracts.ts` — `signContractSchema`, `InterpolatableVariableKey`
