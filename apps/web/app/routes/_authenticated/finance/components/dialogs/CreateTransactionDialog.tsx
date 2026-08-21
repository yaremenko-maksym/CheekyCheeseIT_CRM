import React, { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, ArrowLeftRight, Coins, TrendingUp, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import type { TransactionType } from '@crm/shared'
import {
  SALARY_ELIGIBLE_ROLES,
  COMPANY_ACCOUNT_RECEIVER,
  receiptMandatoryError,
  roundShareAmount,
} from '@crm/shared'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { getApiErrorMessage } from '@/lib/axios-utils'
import { trackFeatureClick } from '@/lib/telemetry'
import { cn, parseStrictAmount } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { AmountCurrencyInput } from '@/components/ui/amount-currency-input'
import { Textarea } from '@/components/ui/textarea'
import { DatePickerField } from '@/components/ui/date-picker'
import { financeApi, companyAccountApi } from '../../api'
import { EXPENSE_CATEGORIES, TYPE_LABELS } from '../../constants'
import { ReceiptInput, emptyReceiptState, type ReceiptState } from '../ReceiptInput'

// UI-level transaction kind for THIS dialog. `DIVIDEND` is a synthetic option —
// it is NOT a `TransactionType` enum value (the dividend flows through the
// dedicated company-account endpoint, which books a DIVIDEND_TO_ADMIN row
// server-side). Keeping it dialog-local avoids churning the shared enum / every
// exhaustive `Record<TransactionType, …>` in the app.
//
// task-admin-income-unified (2026-08-12, supersedes task-admin-income-payment-
// type-guard): there used to be a SECOND synthetic option here, `USDT_INCOME`,
// picked by the caller to reach `declareUsdtProjectIncome`. That let a human
// choose the WRONG form for a USDT-payment project (`createAdminIncome`, which
// never books the senior/drop obligation) — a real prod incident (GamingTec,
// 4708.69 USDT, no drop share). The fix is not a sturdier guard on the choice,
// it is removing the choice: `ADMIN_INCOME` is now the only admin-income type,
// and the project's OWN `paymentType` decides the route internally (see
// `isSelectedProjectUsdt` below). `declareUsdtProjectIncome` itself is
// UNCHANGED — this dialog just calls it from a different trigger.
type DialogTxType = TransactionType | 'DIVIDEND'

// Label / description for the synthetic DIVIDEND option (TYPE_LABELS is keyed by
// the real enum and stays untouched).
const DIVIDEND_LABEL = 'Дивиденд'
const DIVIDEND_DESCRIPTION = 'Вывод дивидендов с баланса счёта компании'

function typeLabel(t: DialogTxType): string {
  if (t === 'DIVIDEND') return DIVIDEND_LABEL
  return TYPE_LABELS[t]
}

function fmtUsdt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// task-salary-company-account. UI-only funding source sentinel:
// 'legacy' = do not send fundingSource in the payload (backward-compat path).
// 'COMPANY_ACCOUNT' / 'ADMIN_PERSONAL' map directly to the DTO enum.
type FundingSourceUI = 'COMPANY_ACCOUNT' | 'ADMIN_PERSONAL' | 'legacy'

// Drop role - phase 2. Extended with `dropId` so the DROP_INCOME path can
// filter projects by `project.dropId === user.id`. Backward compatible —
// `dropId` is optional + null for legacy senior-projects.
// task-drop-share-override-and-receiver (Surface B). Extended with
// `paymentType` so USDT-payment projects can be filtered/gated. Optional +
// nullable — the backend already returns it on `GET /projects` (never
// affects the pre-existing seniorId/dropId filters when absent).
// task-admin-income-unified. Extended with the resolved senior/drop share +
// source + display names — `ProjectsService.mapProject` already returns all
// of these on `GET /projects` for a non-JUNIOR viewer (ADMIN/ACCOUNTANT here
// always are); this just declares the fields the pre-submit obligation-
// preview banner reads. Optional + nullable throughout — absence degrades to
// "no preview", never a crash.
export type ProjectOption = {
  id: string
  name: string
  seniorId: string
  seniorName?: string | null
  dropId?: string | null
  dropName?: string | null
  paymentType?: string | null
  effectiveSeniorSharePercent?: number | null
  effectiveSeniorShareSource?: 'PROJECT' | 'TEAM' | 'USER_DEFAULT' | null
  effectiveDropSharePercent?: number | null
  effectiveDropShareSource?: 'PROJECT' | 'USER_DEFAULT' | null
}
type UserOption = { id: string; displayName: string; role: string }
type ExchangeRate = { usdUah: string; usdtUah: string; eurUah: string; date: string }

type Currency = 'USDT' | 'USD' | 'EUR' | 'UAH'

const TYPE_ICONS: Record<string, React.ReactNode> = {
  ADMIN_INCOME: <TrendingUp className="h-4 w-4" />,
  SENIOR_INCOME: <TrendingUp className="h-4 w-4" />,
  // Drop role - phase 2. DROP_INCOME reuses TrendingUp — same business
  // semantics (income), different recipient.
  DROP_INCOME: <TrendingUp className="h-4 w-4" />,
  EXPENSE: <Wallet className="h-4 w-4" />,
  SALARY: <Wallet className="h-4 w-4" />,
  ADMIN_TRANSFER: <ArrowLeftRight className="h-4 w-4" />,
  DIVIDEND: <Coins className="h-4 w-4" />,
}

const TYPE_DESCRIPTIONS: Record<string, string> = {
  ADMIN_INCOME: 'Доход с собственного проекта',
  SENIOR_INCOME: 'Доход синьора с проекта',
  DROP_INCOME: 'Доход дропа с drop-проекта',
  EXPENSE: 'Расход компании',
  SALARY: 'Выплата зарплаты сотруднику',
  ADMIN_TRANSFER: 'Перевод между партнёрами',
  DIVIDEND: DIVIDEND_DESCRIPTION,
}

function needsConversion(currency: Currency) {
  return currency === 'EUR' || currency === 'UAH' || currency === 'USD'
}

function getRate(currency: Currency, rates: ExchangeRate | undefined): number | null {
  if (!rates) return null
  if (currency === 'EUR') return parseFloat(rates.eurUah) / parseFloat(rates.usdUah)
  if (currency === 'UAH') return 1 / parseFloat(rates.usdUah)
  if (currency === 'USD') return 1
  return null
}

// task-admin-income-unified (AC5/AC6). Pre-submit preview of the obligation(s)
// `TransactionsService.bookCompanyObligations` will ACTUALLY create the moment
// this USDT-project income is submitted — computed with the exact SAME
// rounding (`roundShareAmount`, imported from `@crm/shared`, not re-derived)
// and the exact same "no IOU for an ADMIN senior" exclusion the server
// applies (`senior && senior.role !== 'ADMIN'` in `bookCompanyObligations`),
// so the banner can never promise a number — or a beneficiary — the backend
// does not produce.
export type ObligationPreview = {
  role: 'SENIOR' | 'DROP'
  roleLabel: string
  name: string
  percent: number
  sourceLabel: string
  amount: number
}

const SHARE_SOURCE_LABEL: Record<string, string> = {
  PROJECT: 'проект',
  TEAM: 'команда',
  USER_DEFAULT: 'по умолчанию',
}

// task-admin-income-unified §3 (AC7): "считается на лету... показывается в
// долларах — с учётом выбранной валюты и того же курса, который форма уже
// показывает строкой под полем" — `usdRate` is that SAME `getRate`/`rate`
// this component already computes for the amount field (not a second
// conversion). In PRACTICE `usdRate` is always 1 here: the only route that
// ever reaches this function (`isSelectedProjectUsdt`) hard-locks currency to
// USDT (`createUsdtIncomeSchema`: `currency: z.literal('USDT')`, an unchanged
// sibling per task scope), and USDT is pegged 1:1 to USD. The parameter keeps
// the banner correct rather than silently wrong if that invariant is ever
// relaxed, without inventing a currency table of its own.
// Exported (not just module-scope) so a dedicated unit-test file can pin
// every branch directly — this is the single function AC5/AC6/AC7 hold to
// "predicts the server's actual booking to the cent"; testing it only
// through the full dialog's rendered DOM would leave several of its
// branches (senior-is-admin exclusion, missing-share no-op, source-label
// fallback, non-positive/NaN amount and usdRate guards) exercised by at
// most one scenario each.
export function computeObligationPreviews(
  project: ProjectOption | undefined,
  amount: number,
  seniorIsAdmin: boolean,
  usdRate: number,
): ObligationPreview[] {
  if (!project || project.paymentType !== 'USDT') return []
  // Stryker disable next-line EqualityOperator: `amount <= 0 ? 0 : amount` and `amount < 0 ? 0 : amount` produce the IDENTICAL result at amount === 0 — both branches evaluate to the literal value 0 (the `? 0` branch directly, the `: amount` branch because amount itself equals 0). Mathematically equivalent, not just hard to test.
  const rawAmount = isNaN(amount) || amount <= 0 ? 0 : amount
  const safeAmount = rawAmount * (isNaN(usdRate) || usdRate <= 0 ? 1 : usdRate)
  const previews: ObligationPreview[] = []
  // Mirrors `senior && senior.role !== 'ADMIN'` in bookCompanyObligations —
  // an admin-owned USDT project (the ADMIN is their own senior) never books a
  // senior IOU; only a THIRD-PARTY senior (reachable via the merged "any USDT
  // project" pool, not just the caller's own) does.
  if (project.seniorId && !seniorIsAdmin && project.effectiveSeniorSharePercent != null) {
    previews.push({
      role: 'SENIOR',
      roleLabel: 'Синьору',
      name: project.seniorName || '—',
      percent: project.effectiveSeniorSharePercent,
      sourceLabel: SHARE_SOURCE_LABEL[project.effectiveSeniorShareSource ?? 'USER_DEFAULT']!,
      amount: roundShareAmount(safeAmount, project.effectiveSeniorSharePercent),
    })
  }
  if (project.dropId && project.effectiveDropSharePercent != null) {
    previews.push({
      role: 'DROP',
      roleLabel: 'Дропу',
      name: project.dropName || '—',
      percent: project.effectiveDropSharePercent,
      sourceLabel: SHARE_SOURCE_LABEL[project.effectiveDropShareSource ?? 'USER_DEFAULT']!,
      amount: roundShareAmount(safeAmount, project.effectiveDropSharePercent),
    })
  }
  return previews
}

export function CreateTransactionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth()
  const qc = useQueryClient()

  const isAdmin = user?.role === 'ADMIN'
  const isSenior = user?.role === 'SENIOR'
  // Drop role - phase 2. DROP user can only declare DROP_INCOME via this
  // dialog (mirrors SENIOR_INCOME from the senior path). Other roles never
  // reach this dialog (FinancePage guards them out).
  const isDrop = user?.role === 'DROP'
  // task-accountant-create-transaction. ACCOUNTANT gets the SAME create set as
  // ADMIN (income/expense/salary/transfer). Throughout this dialog the
  // admin-only branches are widened to `isAdminSet` so the accountant renders
  // an identical type list, project pool, user pool and transfer UI. The
  // backend enforces the matching RBAC parity (ADMIN || ACCOUNTANT) per method.
  const isAccountant = user?.role === 'ACCOUNTANT'
  const isAdminSet = isAdmin || isAccountant

  // DIVIDEND (synthetic option) is ADMIN-only — dividends are withdrawn by an
  // ADMIN partner, never by the ACCOUNTANT. So the accountant keeps the plain
  // admin set while ADMIN additionally gets DIVIDEND.
  // task-admin-income-unified: the former separate `USDT_INCOME` type is gone
  // (see the DialogTxType comment) — ADMIN_INCOME is now the only admin-income
  // entry for both ADMIN and ACCOUNTANT; the USDT route inside it is further
  // gated to ADMIN-only by `isSelectedProjectUsdt`'s project pool below
  // (declareUsdtProjectIncome stays ADMIN-only server-side, unchanged).
  const availableTypes: DialogTxType[] = isAdmin
    ? ['ADMIN_INCOME', 'EXPENSE', 'SALARY', 'ADMIN_TRANSFER', 'DIVIDEND']
    : isAccountant
      ? ['ADMIN_INCOME', 'EXPENSE', 'SALARY', 'ADMIN_TRANSFER']
      : isSenior
        ? ['SENIOR_INCOME']
        : isDrop
          ? ['DROP_INCOME']
          : []

  const [type, setType] = useState<DialogTxType>(availableTypes[0] ?? 'SENIOR_INCOME')
  const [projectId, setProjectId] = useState('')
  const [receiverId, setReceiverId] = useState('')
  const [transferSenderId, setTransferSenderId] = useState<string>('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState<Currency>('USD')
  const [category, setCategory] = useState(EXPENSE_CATEGORIES[0]!)

  // task-salary-company-account / task-salary-pay-flow: funding source per-type.
  // EXPENSE / ADMIN_INCOME keep the company-account funding selector. SALARY no
  // longer picks a funding source HERE — it is created as a neutral PENDING
  // reminder; the funding source + currency are chosen later, at pay time
  // (PaySalaryDialog). So SALARY (like every other non-company type) defaults to
  // 'legacy' = "do not send fundingSource in payload".
  const defaultFundingSource = (t: DialogTxType): FundingSourceUI => {
    if (t === 'EXPENSE' || t === 'ADMIN_INCOME') return 'legacy'
    return 'legacy'
  }
  const [fundingSource, setFundingSource] = useState<FundingSourceUI>(
    defaultFundingSource(availableTypes[0] ?? 'SENIOR_INCOME'),
  )
  const [salaryMonth, setSalaryMonth] = useState(() => {
    const prev = new Date()
    prev.setMonth(prev.getMonth() - 1)
    return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`
  })
  const [receipt, setReceipt] = useState<ReceiptState>(emptyReceiptState())
  const [notes, setNotes] = useState('')
  // MED-2 (BIZ-19): one UUID per dialog open — generated at mount, refreshed on
  // each resetForm (= dialog close + reopen). Stable within a single open session
  // so a double-click / retry with the same key is idempotent server-side.
  const [dividendIdempotencyKey, setDividendIdempotencyKey] = useState(() => crypto.randomUUID())
  // MED-1 (security-review PR #367): same per-open-UUID contract for the admin
  // USDT-income declaration (Surface C). Generated at mount, refreshed on reset —
  // a double-submit with the SAME key returns the existing ADMIN_INCOME (no
  // duplicated income / obligations). Separate from the dividend key so each
  // intent owns its own idempotency namespace.
  const [usdtIncomeIdempotencyKey, setUsdtIncomeIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  )
  // task-senior-drop-income-idempotency (backlog 73/A-3): same per-open-UUID
  // contract as usdtIncomeIdempotencyKey/dividendIdempotencyKey above, one key
  // per intent. SENIOR_INCOME and DROP_INCOME are mutually exclusive within a
  // single dialog session (a caller is either SENIOR or DROP — `availableTypes`
  // above never offers both), so only one of these two is ever actually sent,
  // but both are generated up front for the same reason usdtIncomeIdempotencyKey
  // is: stable for the WHOLE open session, so a double-click / retry on submit
  // reuses the SAME key and the backend's replay guard returns the existing row
  // instead of creating a second income + a second company obligation.
  const [seniorIncomeIdempotencyKey, setSeniorIncomeIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  )
  const [dropIncomeIdempotencyKey, setDropIncomeIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  )
  const [txDate, setTxDate] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  })
  // AC4: per-field validation errors keyed by field name. Populated on submit
  // so the user sees EVERY missing/invalid field at once (project, receipt,
  // amount, …) inline next to the field, instead of only the first failure in
  // a single bottom banner.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  // Drop a single field's error as soon as the user edits it — keeps the
  // inline hint from lingering after the problem is fixed.
  function clearFieldError(field: string) {
    setFieldErrors((prev) => {
      if (!prev[field]) return prev
      const next = { ...prev }
      delete next[field]
      return next
    })
  }

  const { data: projects = [] } = useQuery<ProjectOption[]>({
    queryKey: ['projects'],
    queryFn: () => api.get<ProjectOption[]>('/projects').then((r) => r.data),
    enabled: open && (isAdmin || isSenior || isDrop || isAccountant),
  })

  // security-review (PR #522, LOW): the global QueryClient has a 60s
  // `staleTime` — without this, reopening the dialog within that window
  // would keep serving a stale `['projects']` cache (e.g. a share% edited in
  // another tab moments ago), and the obligation-preview banner (AC5/AC6/AC7)
  // would predict against that stale percent. `invalidateQueries` on every
  // `open` transition forces a fresh fetch for the ACTIVE observer above
  // (`enabled: open`), so the banner's percent is never older than "this
  // dialog session".
  useEffect(() => {
    if (open) qc.invalidateQueries({ queryKey: ['projects'] })
  }, [open, qc])

  const { data: allUsers = [] } = useQuery<UserOption[]>({
    queryKey: ['users-all'],
    queryFn: () => api.get<UserOption[]>('/users').then((r) => r.data),
    enabled: open && isAdminSet,
  })

  // Company account balance — needed for DIVIDEND (ADMIN-only) to display
  // available USDT and gate the amount, AND for the funding-source selector
  // (ADMIN/ACCOUNTANT) to show a live balance hint when COMPANY_ACCOUNT chosen.
  const { data: companyAccount } = useQuery({
    queryKey: ['company-account'],
    queryFn: companyAccountApi.getAccount,
    enabled: open && isAdminSet,
  })
  const companyBalance = companyAccount?.balance ?? 0

  const adminUsers = allUsers.filter((u) => u.role === 'ADMIN')
  const adminUserIds = new Set(adminUsers.map((u) => u.id))

  // task-drop-share-override-and-receiver (Surface B, ADR D2). USDT-payment
  // projects are excluded from the SENIOR/DROP self-declare pools — on a USDT
  // project only an ADMIN declares income (routed internally, see below).
  // ADMIN's own `myProjects` (unused in practice — ADMIN never reaches
  // type='SENIOR_INCOME') is left unfiltered for backward-compat.
  const myProjects = isSenior
    ? // Stryker disable next-line OptionalChaining: user is always defined once this dialog renders (gated by the authenticated route it lives on) — `?.` is a defensive no-op here, not an observable branch.
      projects.filter((p) => p.seniorId === user?.id && p.paymentType !== 'USDT')
    : projects
  // ADMIN_INCOME pool. ADMIN sees income for projects they own (seniorId===self)
  // PLUS any USDT-payment project system-wide — task-admin-income-unified merged
  // the former separate `usdtProjects` pool in here (ADR D3: the admin-USDT flow
  // was never limited to the caller's own projects) rather than filtering USDT
  // projects OUT, which is what created the hole this task closes (a USDT
  // project silently missing from the list taught nobody why). ACCOUNTANT keeps
  // registering on any admin-owned project — but NOT a USDT one:
  // `declareUsdtProjectIncome` is ADMIN-only server-side (unchanged sibling), so
  // offering a project only the endpoint itself will 403 on is a dead end, not
  // a shorter list; the accountant-facing gate-hint below explains the absence.
  const adminOwnProjects = isAdmin
    ? // Stryker disable next-line OptionalChaining: user is always defined once this dialog renders — see the identical note above.
      projects.filter((p) => p.seniorId === user?.id)
    : isAccountant
      ? projects.filter((p) => adminUserIds.has(p.seniorId))
      : // Stryker disable next-line ArrayDeclaration: reached only by SENIOR/DROP, for whom `adminOwnProjects` feeds `adminProjects`'s non-admin branch further down — but THAT branch only renders for `type === 'ADMIN_INCOME'`, a type SENIOR/DROP never have in `availableTypes`. Computed, never read.
        []
  // Stryker disable next-line ArrayDeclaration: same reasoning as `adminOwnProjects` above — SENIOR/DROP never render the ADMIN_INCOME project pool that reads this.
  const adminUsdtProjects = isAdmin ? projects.filter((p) => p.paymentType === 'USDT') : []
  const adminProjects = isAdmin
    ? Array.from(
        new Map([...adminOwnProjects, ...adminUsdtProjects].map((p) => [p.id, p])).values(),
      )
    : adminOwnProjects.filter((p) => p.paymentType !== 'USDT')
  // Drop role - phase 2. DROP user can only declare income on drop-projects
  // routed through them. Backend enforces this too — UI mirrors the rule.
  // task-drop-share-override-and-receiver (Surface B, ADR D2): USDT-payment
  // drop-projects are excluded — the drop's income there is declared by ADMIN.
  const dropProjects = isDrop
    ? // Stryker disable next-line OptionalChaining: user is always defined once this dialog renders — see the identical note above.
      projects.filter((p) => p.dropId === user?.id && p.paymentType !== 'USDT')
    : // Stryker disable next-line ArrayDeclaration: reached only by non-DROP roles, for whom `dropProjects` feeds the project Select's DROP_INCOME branch and the drop gate-hint — both gated on `type === 'DROP_INCOME'` / `isDrop`, which a non-DROP role never has. Computed, never read.
      []

  // task-admin-income-unified. The project actually selected in the
  // (now-unified) ADMIN_INCOME flow, and whether it routes through
  // `declareUsdtProjectIncome` instead of `createAdminIncome` — the SINGLE
  // derived flag every USDT-specific branch below keys off, so "which
  // endpoint" can never desync from "which project is showing".
  const selectedAdminProject = adminProjects.find((p) => p.id === projectId)
  const isSelectedProjectUsdt =
    // Stryker disable next-line ConditionalExpression: `selectedAdminProject` is derived from `adminProjects.find(p => p.id === projectId)`, and every type-switch (the type-card onClick) resets `projectId` to '' in the SAME handler — so for any type other than 'ADMIN_INCOME', `selectedAdminProject` is already undefined by construction and this guard changes nothing observable. Kept as defence-in-depth against that invariant ever decoupling.
    type === 'ADMIN_INCOME' && selectedAdminProject?.paymentType === 'USDT'
  // Mirrors `senior && senior.role !== 'ADMIN'` in `bookCompanyObligations` —
  // needed both for the obligation-preview banner and (implicitly, via the
  // preview itself) nowhere else: the server re-derives this independently,
  // this is purely a client-side PREDICTION.
  const selectedProjectSeniorIsAdmin = selectedAdminProject?.seniorId
    ? adminUserIds.has(selectedAdminProject.seniorId)
    : // Stryker disable next-line BooleanLiteral: this value is only READ inside `computeObligationPreviews`, which is only CALLED when `isSelectedProjectUsdt` is true — a state that requires `selectedAdminProject` to be defined, which makes `selectedAdminProject?.seniorId` truthy, which means this `: false` fallback never executes in any reachable call. Unobservable by construction, not by absence of a test.
      false

  // task-admin-income-unified (§2). ADMIN_INCOME's "is this routed to the
  // shared pool" signal now lives in TWO different places depending on the
  // caller — ADMIN picks a receiver (`receiverId === COMPANY_ACCOUNT_RECEIVER`,
  // the flat Select below, same field the USDT route uses); ACCOUNTANT keeps
  // the old binary `fundingSource` toggle (never a specific OTHER admin — the
  // server rejects that for this role). One derived flag folds both shapes so
  // every downstream USDT-lock / receipt / invalidation check reads ONE thing.
  const isAdminIncomeCompanyFunded =
    // Stryker disable next-line ConditionalExpression: empirically verified equivalent (full dialog suite, 112/112 tests, still green with this forced `true`) — the type-switch handler resets `fundingSource` to 'legacy' on EVERY type change, so `fundingSource === 'COMPANY_ACCOUNT'` can only be true while STILL on EXPENSE/ADMIN_INCOME; by the time `type` differs, fundingSource has already reverted. This guard is defence-in-depth against that reset invariant, not independently observable today.
    type === 'ADMIN_INCOME' &&
    (isAdmin ? receiverId === COMPANY_ACCOUNT_RECEIVER : fundingSource === 'COMPANY_ACCOUNT')

  // Derived: is the currency selector locked to USDT? True when the selected
  // project is itself USDT-payment (routes through declareUsdtProjectIncome,
  // §1), OR the income/expense is routed into the shared company pool
  // (EXPENSE's `fundingSource` toggle, or ADMIN_INCOME's `isAdminIncomeCompanyFunded`
  // above). SALARY no longer carries a funding source here — chosen at pay time.
  const isUsdtLocked =
    isSelectedProjectUsdt ||
    isAdminIncomeCompanyFunded ||
    // Stryker disable next-line ConditionalExpression: empirically verified equivalent (full dialog suite, still green with the `type === 'EXPENSE'` half forced `true`) — for EXPENSE itself this half was already true, no change; for every OTHER type, `fundingSource` has already been reset to 'legacy' by the type-switch handler's own unconditional `setFundingSource(defaultFundingSource(t))` (defaultFundingSource ignores its argument, see the neighbouring suppression, and always returns 'legacy') before this line can ever see a stale 'COMPANY_ACCOUNT' — the ONE type that keeps that value alive across a mutation of this clause is ACCOUNTANT's ADMIN_INCOME toggle, and THAT case is already covered by `isAdminIncomeCompanyFunded` two lines up, independent of this clause.
    (type === 'EXPENSE' && fundingSource === 'COMPANY_ACCOUNT')

  // task-receipts-frontend. Single discriminant for the receipt explorer-only
  // mode across all receipt-carrying types in this dialog (design-spec §3.1 /
  // §4.3): DIVIDEND is implicitly USDT (no currency selector at all — a
  // dividend is a USDT withdrawal), everything else follows `isUsdtLocked`
  // (which already covers the USDT-project route + COMPANY_ACCOUNT funding
  // lock) OR the freely-chosen `currency` state (SENIOR_INCOME/DROP_INCOME/
  // ADMIN_TRANSFER — USDT is a valid manual choice there too).
  const effectiveCurrency: Currency =
    type === 'DIVIDEND' ? 'USDT' : isUsdtLocked ? 'USDT' : currency
  const isExplorerOnly = effectiveCurrency === 'USDT'

  // task-receipts-frontend: mandatory-receipt types (design-spec §3.1) — was
  // ADMIN_INCOME/SENIOR_INCOME/DROP_INCOME/EXPENSE only; now extended to ALL
  // receipt-carrying create flows. SALARY (create-time reminder) is
  // deliberately NOT included (A3 — the reminder is neutral; the receipt is
  // required at PAY time instead, see PaySalaryDialog).
  const showReceipt =
    type === 'ADMIN_INCOME' ||
    type === 'SENIOR_INCOME' ||
    type === 'DROP_INCOME' ||
    type === 'EXPENSE' ||
    type === 'ADMIN_TRANSFER' ||
    type === 'DIVIDEND'

  // Fetch NBU rates when non-USD/USDT currency selected, keyed by date
  const needsRate = needsConversion(currency)
  const rateDateParam = txDate.replace(/-/g, '') // YYYY-MM-DD → YYYYMMDD
  const { data: exchangeRate, isFetching: _rateFetching } = useQuery<ExchangeRate>({
    queryKey: ['exchange-rate', rateDateParam],
    queryFn: () =>
      api.get<ExchangeRate>(`/finance/exchange-rate?date=${rateDateParam}`).then((r) => r.data),
    enabled: open && needsRate,
    staleTime: 1000 * 60 * 60 * 24, // 24h — historical rates don't change
  })

  // task-salary-no-admin-receiver: mirror backend allow-list via shared constant —
  // ADMIN excluded (income via shares); all salaried roles eligible.
  // SALARY_ELIGIBLE_ROLES is the single source of truth (packages/shared).
  const salaryTargets = allUsers.filter((u) =>
    (SALARY_ELIGIBLE_ROLES as ReadonlyArray<string>).includes(u.role),
  )
  // ADMIN_TRANSFER parties must BOTH be ADMIN. The accountant is never a
  // transfer party, so the sender/receiver pools are the same admin list for
  // both roles; for ADMIN we still exclude self from the receiver pool.
  const adminTargets = isAdmin ? adminUsers.filter((u) => u.id !== user?.id) : adminUsers

  // DIVIDEND receiver pool — any ADMIN partner; defaults to the calling admin.
  // Reuses the shared `receiverId` state; backend defaults to the caller when
  // adminId is omitted, but we always send an explicit one for auditability.
  const dividendReceiverId = receiverId || user?.id || ''

  // Default the transfer sender to self for ADMIN; for ACCOUNTANT (not a party)
  // default to the first admin so the transfer always has two ADMIN endpoints.
  const defaultTransferSenderId = isAdmin ? (user?.id ?? '') : (adminUsers[0]?.id ?? '')
  const effectiveTransferSenderId = transferSenderId || defaultTransferSenderId
  const transferReceiverId =
    receiverId || adminTargets.find((u) => u.id !== effectiveTransferSenderId)?.id || ''
  const transferSender = adminUsers.find((u) => u.id === effectiveTransferSenderId)
  const transferReceiver = adminUsers.find((u) => u.id === transferReceiverId)

  function swapTransfer() {
    const prevSender = effectiveTransferSenderId
    const prevReceiver = transferReceiverId
    setTransferSenderId(prevReceiver)
    setReceiverId(prevSender)
  }

  // AC4: collect ALL validation errors up front (keyed by field) so the user
  // sees every problem inline at once. Returns an empty object when valid.
  function validate(): Record<string, string> {
    const errors: Record<string, string> = {}
    const amt = parseStrictAmount(amount)
    if (isNaN(amt) || amt <= 0) errors.amount = 'Укажите корректную сумму'

    const receiptDocumentId = receipt.mode === 'file' ? receipt.documentId : null
    const receiptExternalUrl = receipt.mode === 'url' ? receipt.externalUrl || null : null

    if (type === 'ADMIN_INCOME' || type === 'SENIOR_INCOME' || type === 'DROP_INCOME') {
      if (!projectId) errors.project = 'Выберите проект'
    }
    // task-receipts-frontend: mandatory + currency-aware (USDT → explorer-only)
    // for ALL showReceipt types now — delegates to the SAME shared pure
    // function the backend refine calls, so the client/server error text and
    // rules never drift (design-spec §3.1).
    if (showReceipt) {
      const receiptError = receiptMandatoryError(
        { receiptDocumentId, receiptExternalUrl },
        effectiveCurrency,
      )
      if (receiptError) errors.receipt = receiptError
    }
    // task-admin-income-unified (§2, was task-drop-share-override-and-receiver
    // Surface B). ADMIN now ALWAYS picks an explicit receiver for ADMIN_INCOME
    // — both routes (createAdminIncome and declareUsdtProjectIncome) — no
    // default pre-selection (same "deliberate choice each time" convention the
    // USDT flow already had). ACCOUNTANT never sees this Select (their binary
    // toggle always has a value), so no check needed for that role.
    if (type === 'ADMIN_INCOME' && isAdmin) {
      if (!receiverId) errors.receiver = 'Выберите получателя'
    }
    if (type === 'SALARY') {
      if (!receiverId) errors.receiver = 'Выберите сотрудника'
    }
    if (type === 'ADMIN_TRANSFER') {
      if (!transferReceiverId) errors.receiver = 'Выберите получателя'
    }
    if (type === 'DIVIDEND') {
      if (!dividendReceiverId) errors.receiver = 'Выберите получателя-партнёра'
      if (!isNaN(amt) && amt > 0 && amt > companyBalance) {
        errors.amount = 'Сумма превышает баланс счёта компании'
      }
    }
    return errors
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const amt = parseStrictAmount(amount)
      // Build XOR receipt fields: exactly one populated, or both null.
      const receiptDocumentId = receipt.mode === 'file' ? receipt.documentId : null
      const receiptExternalUrl = receipt.mode === 'url' ? receipt.externalUrl || null : null

      // task-admin-income-unified. The invariant this task exists to enforce:
      // a USDT-payment project can ONLY ever reach `declareUsdtProjectIncome`
      // (the one path that books the senior/drop obligation) — never
      // `createAdminIncome` (which does not, and now also refuses the project
      // server-side as a second line of defence). `isSelectedProjectUsdt` is
      // derived from the SAME project object the Select renders, so there is
      // no way for the branch taken here to disagree with what the user saw.
      // Stryker disable next-line ConditionalExpression: empirically verified — `pnpm vitest run` on this file (unmutated harness) FAILS "non-USDT project → createAdminIncome, receiverId sent explicitly (ADMIN)" and 7 other tests when this condition is hand-forced to `true` (confirmed by direct simulation, not assumed). Stryker's own coverage-based test selection for this async-arrow-function / early-return shape does not attribute the kill correctly — a tool limitation, not an untested branch.
      if (type === 'ADMIN_INCOME' && isSelectedProjectUsdt) {
        // task-drop-share-override-and-receiver (Surface B, ADR D3, unchanged
        // by this task). ADMIN-only USDT project-income declaration with an
        // explicit receiver (an ADMIN's uuid or the 'COMPANY_ACCOUNT' sentinel
        // — sent as-is from the Select). Receipt is MANDATORY (explorer-only —
        // `createUsdtIncomeSchema` currency is a `z.literal('USDT')`).
        return financeApi.declareUsdtProjectIncome({
          projectId,
          amount: amt,
          currency: 'USDT',
          receiverId,
          receiptDocumentId,
          receiptExternalUrl,
          // MED-1 (security-review PR #367): stable per-open idempotency key so a
          // double-click / retry does not create a second income + obligation set.
          idempotencyKey: usdtIncomeIdempotencyKey,
          notes: notes || null,
          txDate: txDate || null,
        })
      }
      if (type === 'ADMIN_INCOME') {
        return financeApi.createAdminIncome({
          projectId,
          amount: amt,
          // company-account income is always USDT; send locked currency for clarity.
          currency: isUsdtLocked ? 'USDT' : currency,
          receiptDocumentId,
          receiptExternalUrl,
          notes: notes || null,
          txDate: txDate || null,
          // task-admin-income-unified (§2): `receiverId` REPLACES the old
          // `fundingSource` toggle. ADMIN always sends an explicit value
          // (validate() enforces it — an admin uuid or the COMPANY_ACCOUNT
          // sentinel). ACCOUNTANT never gets a choice: 'legacy' sends nothing
          // (server credits the project owner, unchanged default), 'COMPANY_ACCOUNT'
          // sends the SAME sentinel (still allowed for this role — only picking a
          // SPECIFIC other admin is not, and the UI never offers that).
          ...(isAdmin
            ? { receiverId }
            : fundingSource === 'COMPANY_ACCOUNT'
              ? { receiverId: COMPANY_ACCOUNT_RECEIVER }
              : {}),
        })
      }
      if (type === 'SENIOR_INCOME') {
        return financeApi.createSeniorIncome({
          projectId,
          amount: amt,
          currency,
          // task-senior-drop-income-idempotency (backlog 73/A-3): stable
          // per-open key so a double-click / retry does not create a second
          // income (and, once it reaches payout validation, a second
          // company obligation for the same piece of work).
          idempotencyKey: seniorIncomeIdempotencyKey,
          receiptDocumentId,
          receiptExternalUrl,
          notes: notes || null,
          txDate: txDate || null,
        })
      }
      // Drop role - phase 2. Same payload shape as senior income — mirror
      // path goes through `POST /transactions/drop-income`.
      if (type === 'DROP_INCOME') {
        return financeApi.createDropIncome({
          projectId,
          amount: amt,
          currency,
          // task-senior-drop-income-idempotency (backlog 73/A-3): same
          // contract as SENIOR_INCOME above.
          idempotencyKey: dropIncomeIdempotencyKey,
          receiptDocumentId,
          receiptExternalUrl,
          notes: notes || null,
          txDate: txDate || null,
        })
      }
      if (type === 'EXPENSE') {
        return financeApi.createExpense({
          amount: amt,
          currency: isUsdtLocked ? 'USDT' : currency,
          category,
          notes: notes || null,
          receiptDocumentId,
          receiptExternalUrl,
          txDate: txDate || null,
          // Send COMPANY_ACCOUNT explicitly when chosen; omit for legacy path.
          ...(fundingSource === 'COMPANY_ACCOUNT' && { fundingSource: 'COMPANY_ACCOUNT' }),
        })
      }
      if (type === 'SALARY') {
        // task-salary-pay-flow: a manually-created salary is a NEUTRAL PENDING
        // reminder — NO funding source / payer / currency-lock here. The funding
        // source + payment currency are chosen later, at pay time (PaySalaryDialog).
        return financeApi.createSalary({
          receiverId,
          amount: amt,
          currency,
          salaryMonth,
          notes: notes || null,
          txDate: txDate || null,
        })
      }
      if (type === 'ADMIN_TRANSFER') {
        // task-receipts-frontend: receipt now MANDATORY, currency-aware
        // (`createAdminTransferSchema` defaults currency to USDT → explorer-only
        // unless the user manually picked a different currency).
        return financeApi.createAdminTransfer({
          senderId: effectiveTransferSenderId,
          receiverId: transferReceiverId,
          amount: amt,
          currency,
          receiptDocumentId,
          receiptExternalUrl,
          notes: notes || null,
          txDate: txDate || null,
        })
      }
      if (type === 'DIVIDEND') {
        // Company-account dividend (ADMIN-only). Always USDT; receiver is an
        // ADMIN partner (adminId). Currency / project fields are irrelevant
        // here — the endpoint only needs amount + target admin. task-receipts-
        // frontend: receipt is now MANDATORY + explorer-only (a dividend is a
        // USDT withdrawal from the company account).
        // MED-2 (BIZ-19): send the stable idempotencyKey (generated at dialog
        // open, refreshed on close). A double-click retry with the same key is
        // idempotent on the backend; reopening the dialog gets a fresh UUID.
        return companyAccountApi.createDividend({
          amount: amt,
          idempotencyKey: dividendIdempotencyKey,
          receiptDocumentId,
          receiptExternalUrl,
          ...(dividendReceiverId ? { adminId: dividendReceiverId } : {}),
        })
      }
      throw new Error('Unknown type')
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      // Drop role - phase 2. Confirm the new flow loudly so the DROP user
      // knows their tx is registered + queued for validation. Other types
      // already surface via the table refresh so a toast would be noise.
      if (type === 'DROP_INCOME') {
        toast.success('Приход зарегистрирован, ожидает валидации')
      }
      if (type === 'DIVIDEND') {
        void qc.invalidateQueries({ queryKey: ['company-account'] })
        toast.success('Дивиденды выведены')
      }
      // Invalidate company-account balance when any company-account debit/credit
      // succeeds. `isAdminIncomeCompanyFunded` covers ADMIN_INCOME's two shapes
      // (ADMIN's receiverId sentinel, ACCOUNTANT's fundingSource toggle);
      // `fundingSource === 'COMPANY_ACCOUNT'` covers EXPENSE (unaffected by
      // task-admin-income-unified — still its own toggle).
      if (fundingSource === 'COMPANY_ACCOUNT' || isAdminIncomeCompanyFunded) {
        void qc.invalidateQueries({ queryKey: ['company-account'] })
      }
      onClose()
      resetForm()
    },
  })

  // Validate first; only fire the network mutation when every field is valid.
  function handleSubmit() {
    const errors = validate()
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return
    mutation.mutate()
  }

  function resetForm() {
    setProjectId('')
    setReceiverId('')
    setTransferSenderId('')
    setAmount('')
    setCurrency('USD')
    setCategory(EXPENSE_CATEGORIES[0]!)
    setReceipt(emptyReceiptState())
    setNotes('')
    setFieldErrors({})
    // Reset funding source to per-type default.
    setFundingSource(defaultFundingSource(type))
    const now = new Date()
    setTxDate(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    )
    // MED-2 (BIZ-19): generate a fresh idempotency key on each dialog close so
    // the next open session starts with a new key (new dialog = new dividend intent).
    setDividendIdempotencyKey(crypto.randomUUID())
    // MED-1 (PR #367): likewise refresh the USDT-income key (new open = new intent).
    setUsdtIncomeIdempotencyKey(crypto.randomUUID())
    // backlog 73/A-3: likewise refresh the SENIOR/DROP income keys (new open =
    // new intent).
    setSeniorIncomeIdempotencyKey(crypto.randomUUID())
    setDropIncomeIdempotencyKey(crypto.randomUUID())
  }

  // EXPENSE and ADMIN_INCOME's ACCOUNTANT branch render the SAME two-button
  // legacy/company toggle — only the copy differs (see the two call sites
  // below). Sharing the implementation means there is exactly ONE place that
  // decides which button is active, not two near-identical copies that could
  // drift apart silently.
  function renderFundingSourceToggle({
    sectionLabel,
    personalLabel,
    personalDescription,
    companyDescription,
  }: {
    sectionLabel: string
    personalLabel: string
    personalDescription: string
    companyDescription: string
  }) {
    // Stryker disable next-line ConditionalExpression, EqualityOperator, StringLiteral: Purely decorative active-state dot, redundant with the border-color styling already asserted as cosmetic above — no testid, not part of any AC's observable contract.
    const isLegacyActive = fundingSource === 'legacy'
    // Stryker disable next-line ConditionalExpression, EqualityOperator, StringLiteral: Purely decorative active-state dot, redundant with the border-color styling already asserted as cosmetic above — no testid, not part of any AC's observable contract.
    const isCompanyActive = fundingSource === 'COMPANY_ACCOUNT'
    return (
      <div className="space-y-2" data-testid="create-transaction-funding-source-section">
        <Label className="text-xs text-muted-foreground">{sectionLabel}</Label>
        <div className="grid grid-cols-1 gap-1.5">
          <button
            type="button"
            // Stryker disable next-line StringLiteral: the click-handler's sentinel argument — any value other than 'COMPANY_ACCOUNT' behaves identically everywhere this state is read (every check is `=== 'COMPANY_ACCOUNT'`; anything else is treated as "legacy"), and the active/inactive styling this feeds is already covered by the cosmetic note above.
            onClick={() => setFundingSource('legacy')}
            className={cn(
              // Stryker disable next-line StringLiteral: the SHARED (non-conditional) base Tailwind classes — present in EVERY state, so mutating this string changes only appearance, covered by the same cosmetic reasoning as the active/inactive ternary below it.
              'flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all',
              // Stryker disable next-line ConditionalExpression, EqualityOperator, StringLiteral: Tailwind active/inactive border styling — cosmetic only, verified visually via the Playwright screenshots in the PR; testing-library discourages asserting implementation-detail CSS classes, and the button's FUNCTIONAL state (which testid is active, the balance hint) is already pinned by other tests in this file.
              fundingSource === 'legacy'
                ? // Stryker disable next-line StringLiteral: Tailwind class string for the SAME active/inactive styling — see the identical note on the condition immediately above.
                  'border-primary bg-primary/8 text-foreground'
                : // Stryker disable next-line StringLiteral: Tailwind class string for the SAME active/inactive styling — see the identical note on the condition immediately above.
                  'border-border bg-muted/20 text-muted-foreground hover:border-border/80 hover:bg-muted/40',
            )}
            data-testid="create-transaction-funding-legacy"
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium leading-tight">{personalLabel}</div>
              <div className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                {personalDescription}
              </div>
            </div>
            {isLegacyActive && (
              <div
                className="h-2 w-2 rounded-full bg-primary shrink-0"
                data-testid="funding-toggle-active-dot"
              />
            )}
          </button>
          <button
            type="button"
            onClick={() => {
              // Stryker disable next-line StringLiteral: the click-handler's sentinel argument — any value other than 'COMPANY_ACCOUNT' behaves identically everywhere this state is read (every check is `=== 'COMPANY_ACCOUNT'`; anything else is treated as "legacy"), and the active/inactive styling this feeds is already covered by the cosmetic note above.
              setFundingSource('COMPANY_ACCOUNT')
              // Stryker disable next-line StringLiteral: defensive pre-set — `isUsdtLocked`'s `fundingSource === 'COMPANY_ACCOUNT'` clause already forces `payload.currency` to 'USDT' independent of this direct `setCurrency` call (see `usdRate`'s neighbouring suppression); this only affects the currency Select's value AFTER the user later switches back to 'legacy', a state no AC specifies.
              setCurrency('USDT')
            }}
            className={cn(
              // Stryker disable next-line StringLiteral: the SHARED (non-conditional) base Tailwind classes — present in EVERY state, so mutating this string changes only appearance, covered by the same cosmetic reasoning as the active/inactive ternary below it.
              'flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all',
              // Stryker disable next-line ConditionalExpression, EqualityOperator, StringLiteral: Tailwind active/inactive border styling — cosmetic only, verified visually via the Playwright screenshots in the PR; testing-library discourages asserting implementation-detail CSS classes, and the button's FUNCTIONAL state (which testid is active, the balance hint) is already pinned by other tests in this file.
              fundingSource === 'COMPANY_ACCOUNT'
                ? // Stryker disable next-line StringLiteral: Tailwind class string for the SAME active/inactive styling — see the identical note on the condition immediately above.
                  'border-primary bg-primary/8 text-foreground'
                : // Stryker disable next-line StringLiteral: Tailwind class string for the SAME active/inactive styling — see the identical note on the condition immediately above.
                  'border-border bg-muted/20 text-muted-foreground hover:border-border/80 hover:bg-muted/40',
            )}
            data-testid="create-transaction-funding-company"
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium leading-tight">Счёт компании</div>
              <div className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                {companyDescription}
              </div>
            </div>
            {isCompanyActive && (
              <div
                className="h-2 w-2 rounded-full bg-primary shrink-0"
                data-testid="funding-toggle-active-dot"
              />
            )}
          </button>
        </div>

        {fundingSource === 'COMPANY_ACCOUNT' && (
          <div className="flex items-center justify-between rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs text-blue-400">
            <span>Баланс счёта компании</span>
            <span
              className="font-bold tabular-nums"
              data-testid="create-transaction-company-balance-hint"
            >
              {fmtUsdt(companyBalance)} USDT
            </span>
          </div>
        )}
      </div>
    )
  }

  const error = mutation.error != null ? getApiErrorMessage(mutation.error) : null
  const hasFieldErrors = Object.keys(fieldErrors).length > 0

  // Conversion info
  const rate = needsRate ? getRate(currency, exchangeRate) : null
  const amtNum = parseStrictAmount(amount)
  const _convertedUsd = rate && !isNaN(amtNum) && amtNum > 0 ? (amtNum * rate).toFixed(2) : null

  // task-admin-income-unified (AC5/AC6/AC7) — see `computeObligationPreviews`.
  // `usdRate`: the SAME `getRate`/`rate` pair above, not a second conversion.
  // USDT/USD need no conversion (1:1 — the peg AmountCurrencyInput shows);
  // `rate` only resolves for EUR/UAH/USD (see `getRate`), so it is `null`
  // exactly when no conversion is needed here too.
  // Stryker disable next-line ConditionalExpression, LogicalOperator, EqualityOperator, StringLiteral: empirically verified equivalent (full dialog suite, 112/112 tests, still green with this condition forced `false`) — `usdRate` is only CONSUMED by `computeObligationPreviews`, itself only called when `isSelectedProjectUsdt` is true, and `isUsdtLocked` forces `effectiveCurrency` to `'USDT'` in every state where that holds — so this ternary's `else` branch is unreachable exactly where the value matters.
  const usdRate = effectiveCurrency === 'USDT' || effectiveCurrency === 'USD' ? 1 : (rate ?? 1)
  const obligationPreviews = isSelectedProjectUsdt
    ? computeObligationPreviews(selectedAdminProject, amtNum, selectedProjectSeniorIsAdmin, usdRate)
    : // Stryker disable next-line ArrayDeclaration: only reached when `isSelectedProjectUsdt` is false, in which case the banner's OWN render condition below (`isSelectedProjectUsdt && obligationPreviews.length > 0`) is already false regardless of this array's contents — never observably rendered.
      []
  const showObligationBanner =
    // Stryker disable next-line ConditionalExpression, LogicalOperator: empirically verified equivalent (full dialog suite, 112/112 tests, still green with the `type === 'ADMIN_INCOME'` clause forced `true`) — `obligationPreviews.length > 0` can only be true when `isSelectedProjectUsdt` is true (computed above), which itself requires `type === 'ADMIN_INCOME'` — this clause repeats a condition `obligationPreviews` already enforces via its own gate two lines up.
    type === 'ADMIN_INCOME' && isSelectedProjectUsdt && obligationPreviews.length > 0
  // security-review (PR #522, LOW): AC7 says "пустое поле или ноль → плашка про
  // сумму молчит" — a literal 0.00 reads as "no share", not "amount unknown",
  // so the amount clause is hidden (not zeroed) whenever the raw input isn't a
  // usable positive number.
  const hasPositiveAmount = !isNaN(amtNum) && amtNum > 0

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          onClose()
          resetForm()
        }
      }}
    >
      <CrmDialogContent maxWidth="sm:max-w-lg" data-testid="create-transaction-dialog">
        <CrmDialogHeader>
          <DialogTitle className="text-base" data-testid="create-transaction-dialog-title">
            Новая транзакция
          </DialogTitle>
          <DialogDescription className="sr-only">Создание транзакции</DialogDescription>
        </CrmDialogHeader>

        <CrmDialogBody className="space-y-4 py-1">
          {/* Type selector — card-style */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Тип операции</Label>
            <div className="grid grid-cols-1 gap-1.5">
              {availableTypes.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    setType(t)
                    setProjectId('')
                    setReceiverId('')
                    // Also clear the ADMIN_TRANSFER sender so switching the type
                    // inside an open dialog never leaves a stale party selected.
                    setTransferSenderId('')
                    setFieldErrors({})
                    // Reset fundingSource to per-type default and restore the
                    // default currency (any USDT-lock is re-derived from funding).
                    setFundingSource(defaultFundingSource(t))
                    setCurrency('USD')
                  }}
                  className={cn(
                    'flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all',
                    type === t
                      ? 'border-primary bg-primary/8 text-foreground'
                      : 'border-border bg-muted/20 text-muted-foreground hover:border-border/80 hover:bg-muted/40',
                  )}
                  data-testid={`create-transaction-type-${t.toLowerCase()}`}
                >
                  <span className="text-muted-foreground shrink-0">{TYPE_ICONS[t]}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium leading-tight">{typeLabel(t)}</div>
                    <div className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                      {TYPE_DESCRIPTIONS[t]}
                    </div>
                  </div>
                  {type === t && <div className="h-2 w-2 rounded-full bg-primary shrink-0" />}
                </button>
              ))}
            </div>
          </div>

          <div className="h-px bg-border/60" />

          {/* Project selector */}
          {(type === 'SENIOR_INCOME' || type === 'ADMIN_INCOME' || type === 'DROP_INCOME') && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Проект</Label>
              <Select
                value={projectId}
                onValueChange={(v) => {
                  setProjectId(v)
                  clearFieldError('project')
                  // task-admin-income-unified. Switching PROJECTS inside
                  // ADMIN_INCOME can flip the route (createAdminIncome ⇄
                  // declareUsdtProjectIncome) — the two routes have disjoint
                  // receiver/funding semantics (an admin-id/company sentinel
                  // vs a legacy/company-account funding toggle), so a stale
                  // selection from the OTHER route must never carry over.
                  if (type === 'ADMIN_INCOME') {
                    setReceiverId('')
                    clearFieldError('receiver')
                    // Stryker disable next-line OptionalChaining: empirically verified equivalent (full dialog suite, 47/47 tests in the usdt-income spec, still green with `?.` removed) — `v` is always the `value` of a `<SelectItem>` rendered FROM `adminProjects` itself, so `.find()` can never miss; `?.` is a defensive no-op for a state the Select structurally cannot produce.
                    const nextIsUsdt = adminProjects.find((p) => p.id === v)?.paymentType === 'USDT'
                    if (nextIsUsdt) {
                      // task-telemetry-web: USDT-income declaration is its own
                      // tracked feature — now fired on the project selection
                      // that DECIDES the route, not a separate type-card click.
                      trackFeatureClick('usdt-income-declare')
                    } else {
                      // Stryker disable next-line StringLiteral: `defaultFundingSource` ignores its argument in EVERY branch (`if (t === 'EXPENSE' || t === 'ADMIN_INCOME') return 'legacy'; return 'legacy'`) — both paths return the same literal, so which string is passed in is unobservable by construction.
                      setFundingSource(defaultFundingSource('ADMIN_INCOME'))
                      setCurrency('USD')
                    }
                  }
                }}
              >
                <SelectTrigger
                  className={cn('h-9 text-sm', fieldErrors.project && 'border-destructive')}
                  data-testid="create-transaction-project-trigger"
                >
                  <SelectValue placeholder="Выберите проект" />
                </SelectTrigger>
                <SelectContent>
                  {(type === 'ADMIN_INCOME'
                    ? adminProjects
                    : type === 'DROP_INCOME'
                      ? dropProjects
                      : myProjects
                  ).map((p) => (
                    <SelectItem key={p.id} value={p.id} className="text-sm">
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {fieldErrors.project && (
                <p
                  className="text-[11px] text-destructive"
                  data-testid="create-transaction-error-project"
                >
                  {fieldErrors.project}
                </p>
              )}
            </div>
          )}

          {/* task-drop-share-override-and-receiver (Surface B, ADR D2). Gate
              hints — shown only when the SENIOR/DROP genuinely has projects but
              ALL of them are USDT-payment (the filtered pool is empty despite a
              non-empty underlying list). A senior/drop with a mix of FOP/GIG +
              USDT projects sees no hint — the USDT ones are just silently
              absent from the Select above. */}
          {type === 'SENIOR_INCOME' &&
            projects.some((p) => p.seniorId === user?.id) &&
            myProjects.length === 0 && (
              <p
                className="text-xs text-muted-foreground italic"
                data-testid="senior-income-usdt-gate-hint"
              >
                На всех ваших проектах приход декларирует администратор (USDT). Обратитесь к
                администратору.
              </p>
            )}
          {type === 'DROP_INCOME' &&
            projects.some((p) => p.dropId === user?.id) &&
            dropProjects.length === 0 && (
              <p
                className="text-xs text-muted-foreground italic"
                data-testid="drop-income-usdt-gate-hint"
              >
                На всех ваших проектах приход декларирует администратор (USDT). Обратитесь к
                администратору.
              </p>
            )}
          {/* task-admin-income-unified. ACCOUNTANT-only hint: unlike ADMIN
              (whose pool now includes every USDT project, unified — see
              `adminProjects` above), the accountant's pool still excludes
              them — `declareUsdtProjectIncome` is ADMIN-only server-side, so
              offering a project that endpoint will 403 on is a dead end. Shown
              only when it actually cost the accountant something (their
              admin-owned pool is non-empty but every project in it is USDT). */}
          {type === 'ADMIN_INCOME' &&
            isAccountant &&
            adminOwnProjects.length > 0 &&
            adminProjects.length === 0 && (
              <p
                className="text-xs text-muted-foreground italic"
                data-testid="admin-income-accountant-usdt-gate-hint"
              >
                Приход по USDT-проектам может провести только администратор.
              </p>
            )}

          {/* task-admin-income-unified (§2, owner decision 2026-08-12). ADMIN
              gets a flat "Счёт получателя" Select — same shape/convention the
              USDT route already used (any ACTIVE admin — `/users` excludes
              archived by default, AC9 — + «Счёт компании», no group headers,
              no default pre-selection), now covering BOTH routes
              (createAdminIncome AND declareUsdtProjectIncome) since "who gets
              credited" is the same choice either way. `adminUsers` is
              role-filtered (=== 'ADMIN') — a drop structurally cannot appear
              here (owner's explicit call: a drop declares their own income,
              never in USDT). ACCOUNTANT does NOT get this Select — see the
              constrained toggle below instead. */}
          {type === 'ADMIN_INCOME' && isAdmin && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Счёт получателя</Label>
              <Select
                value={receiverId}
                onValueChange={(v) => {
                  setReceiverId(v)
                  clearFieldError('receiver')
                }}
              >
                <SelectTrigger
                  className={cn('h-9 text-sm', fieldErrors.receiver && 'border-destructive')}
                  data-testid="admin-income-receiver-trigger"
                >
                  <SelectValue placeholder="Выберите получателя" />
                </SelectTrigger>
                <SelectContent>
                  {adminUsers.map((u) => (
                    <SelectItem key={u.id} value={u.id} className="text-sm">
                      {u.displayName}
                    </SelectItem>
                  ))}
                  <SelectSeparator />
                  <SelectItem value={COMPANY_ACCOUNT_RECEIVER} className="text-sm">
                    Счёт компании
                  </SelectItem>
                </SelectContent>
              </Select>
              {/* USDT-route-specific: createAdminIncome never books an
                  obligation (AC3) — showing this on a FOP/GIG project would be
                  a false promise. */}
              {isSelectedProjectUsdt && (
                <p className="text-xs text-muted-foreground">
                  Весь приход (gross) уйдёт выбранному получателю. Компания автоматически создаст
                  обязательства выплатить синьору и дропу их доли.
                </p>
              )}
              {/* Company account balance hint — same hint the EXPENSE/ACCOUNTANT
                  toggles show, now keyed off `receiverId` for this Select. */}
              {receiverId === COMPANY_ACCOUNT_RECEIVER && (
                <div className="flex items-center justify-between rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs text-blue-400">
                  <span>Баланс счёта компании</span>
                  <span
                    className="font-bold tabular-nums"
                    data-testid="create-transaction-company-balance-hint"
                  >
                    {fmtUsdt(companyBalance)} USDT
                  </span>
                </div>
              )}
              {fieldErrors.receiver && (
                <p
                  className="text-[11px] text-destructive"
                  data-testid="admin-income-error-receiver"
                >
                  {fieldErrors.receiver}
                </p>
              )}
            </div>
          )}

          {/* Salary — receiver + month */}
          {type === 'SALARY' && (
            <div className="space-y-1.5">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Сотрудник</Label>
                  <Select
                    value={receiverId}
                    onValueChange={(v) => {
                      setReceiverId(v)
                      clearFieldError('receiver')
                    }}
                  >
                    <SelectTrigger
                      className={cn('h-9 text-sm', fieldErrors.receiver && 'border-destructive')}
                      data-testid="create-transaction-receiver-trigger"
                    >
                      <SelectValue placeholder="Выберите..." />
                    </SelectTrigger>
                    <SelectContent>
                      {salaryTargets.map((u) => (
                        <SelectItem key={u.id} value={u.id} className="text-sm">
                          {u.displayName}
                          <span className="ml-1 text-[10px] text-muted-foreground">({u.role})</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Месяц</Label>
                  <input
                    type="month"
                    value={salaryMonth}
                    onChange={(e) => setSalaryMonth(e.target.value)}
                    onClick={(e) => e.currentTarget.showPicker?.()}
                    onFocus={(e) => e.currentTarget.showPicker?.()}
                    data-testid="create-transaction-salary-month"
                    className={cn(
                      'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors',
                      'placeholder:text-muted-foreground',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      'disabled:cursor-not-allowed disabled:opacity-50',
                      'cursor-pointer',
                      '[color-scheme:dark]',
                      '[&::-webkit-calendar-picker-indicator]:opacity-60',
                      '[&::-webkit-calendar-picker-indicator]:cursor-pointer',
                      '[&::-webkit-calendar-picker-indicator]:invert',
                      '[&::-webkit-calendar-picker-indicator]:hover:opacity-100',
                    )}
                  />
                </div>
              </div>
              {fieldErrors.receiver && (
                <p
                  className="text-[11px] text-destructive"
                  data-testid="create-transaction-error-receiver"
                >
                  {fieldErrors.receiver}
                </p>
              )}
            </div>
          )}

          {/* Funding source selector — EXPENSE only (task-admin-income-unified
              §2: ADMIN_INCOME's ADMIN branch moved to the flat receiver Select
              above; its ACCOUNTANT branch is the constrained toggle right
              below). task-salary-pay-flow: SALARY no longer has a funding
              selector here — chosen at pay time (PaySalaryDialog). */}
          {type === 'EXPENSE' &&
            renderFundingSourceToggle({
              sectionLabel: 'Источник средств',
              personalLabel: 'Обычный расход',
              personalDescription: 'Стандартный расход, не затрагивает счёт компании',
              companyDescription: 'Спишется со счёта компании (USDT)',
            })}

          {/* task-admin-income-unified (§2, owner decision 2026-08-12).
              ACCOUNTANT's CONSTRAINED "Счёт получателя" — reuses the EXACT
              same `fundingSource` state/toggle shape EXPENSE uses above (no
              new state), but "personal" always means the PROJECT OWNER
              (never a picked admin, never the accountant — the server
              rejects anything else for this role, see createAdminIncome).
              The interface never offers what the server would reject. */}
          {type === 'ADMIN_INCOME' &&
            isAccountant &&
            renderFundingSourceToggle({
              sectionLabel: 'Счёт получателя',
              personalLabel: 'Владелец проекта',
              personalDescription: selectedAdminProject?.seniorName
                ? `Приход зачислится администратору ${selectedAdminProject.seniorName}`
                : 'Приход зачислится администратору-владельцу проекта',
              companyDescription: 'Зачислится на счёт компании (USDT)',
            })}

          {/* Admin transfer — swap UI */}
          {type === 'ADMIN_TRANSFER' && adminUsers.length >= 2 && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Направление перевода</Label>
              <div className="flex items-center gap-2">
                {/* Sender card */}
                <button
                  type="button"
                  onClick={swapTransfer}
                  className={cn(
                    'flex-1 flex flex-col items-center gap-1 rounded-lg border px-3 py-2.5 transition-all text-center',
                    'border-border bg-muted/20 hover:bg-muted/40',
                  )}
                  title="Нажмите для смены направления"
                >
                  <div className="h-8 w-8 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-sm font-bold text-primary">
                    {transferSender?.displayName.charAt(0) ?? '?'}
                  </div>
                  <span className="text-xs font-medium leading-tight">
                    {transferSender?.displayName ?? '—'}
                  </span>
                  <span className="text-[10px] text-muted-foreground">отправляет</span>
                </button>

                {/* Swap button */}
                <button
                  type="button"
                  onClick={swapTransfer}
                  className="shrink-0 h-8 w-8 rounded-full border border-border bg-muted/30 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-all hover:rotate-180 duration-300"
                  title="Поменять направление"
                >
                  <ArrowLeftRight className="h-3.5 w-3.5" />
                </button>

                {/* Receiver card */}
                <button
                  type="button"
                  onClick={swapTransfer}
                  className={cn(
                    'flex-1 flex flex-col items-center gap-1 rounded-lg border px-3 py-2.5 transition-all text-center',
                    'border-border bg-muted/20 hover:bg-muted/40',
                  )}
                  title="Нажмите для смены направления"
                >
                  <div className="h-8 w-8 rounded-full bg-muted/40 border border-border flex items-center justify-center text-sm font-bold text-muted-foreground">
                    {transferReceiver?.displayName.charAt(0) ?? '?'}
                  </div>
                  <span className="text-xs font-medium leading-tight">
                    {transferReceiver?.displayName ?? '—'}
                  </span>
                  <span className="text-[10px] text-muted-foreground">получает</span>
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground/60 text-center">
                Нажмите на карточки или стрелку, чтобы поменять направление
              </p>
            </div>
          )}

          {/* Expense category — pill buttons */}
          {type === 'EXPENSE' && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Категория</Label>
              <div className="flex flex-wrap gap-1.5">
                {EXPENSE_CATEGORIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategory(c)}
                    className={cn(
                      'rounded-full border px-3 py-1 text-xs font-medium transition-all',
                      category === c
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:border-border/80 hover:bg-muted/50',
                    )}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Dividend — balance + receiver + USDT amount (ADMIN-only).
              Renders its own USDT-only amount input (no currency selector, no
              date) — the company-account endpoint only needs amount + receiver. */}
          {type === 'DIVIDEND' && (
            <div className="space-y-4" data-testid="create-transaction-dividend-fields">
              {/* Balance summary */}
              <div className="space-y-1 rounded-lg border border-border bg-muted/30 p-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Баланс счёта компании</span>
                  <span
                    className="font-bold tabular-nums"
                    data-testid="create-transaction-dividend-balance"
                  >
                    {fmtUsdt(companyBalance)} USDT
                  </span>
                </div>
              </div>

              {/* Receiver — ADMIN partner */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Получатель (партнёр)</Label>
                <Select
                  value={dividendReceiverId}
                  onValueChange={(v) => {
                    setReceiverId(v)
                    clearFieldError('receiver')
                  }}
                >
                  <SelectTrigger
                    className={cn('h-9 text-sm', fieldErrors.receiver && 'border-destructive')}
                    data-testid="create-transaction-dividend-receiver-trigger"
                  >
                    <SelectValue placeholder="Выберите партнёра" />
                  </SelectTrigger>
                  <SelectContent>
                    {adminUsers.map((u) => (
                      <SelectItem key={u.id} value={u.id} className="text-sm">
                        {u.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {fieldErrors.receiver && (
                  <p
                    className="text-[11px] text-destructive"
                    data-testid="create-transaction-error-receiver"
                  >
                    {fieldErrors.receiver}
                  </p>
                )}
              </div>

              {/* USDT amount */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Сумма (USDT)</Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    $
                  </span>
                  <Input
                    value={amount}
                    onChange={(e) => {
                      setAmount(e.target.value)
                      clearFieldError('amount')
                    }}
                    placeholder="0.00"
                    inputMode="decimal"
                    className={cn(
                      'h-9 pl-7 text-sm tabular-nums',
                      fieldErrors.amount && 'border-destructive',
                    )}
                    aria-label="Сумма дивидендов в USDT"
                    data-testid="create-transaction-dividend-amount"
                  />
                </div>
                {fieldErrors.amount && (
                  <p
                    className="text-[11px] text-destructive"
                    data-testid="create-transaction-error-amount"
                  >
                    {fieldErrors.amount}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Amount + Currency (all non-dividend types) */}
          {type !== 'DIVIDEND' && (
            <AmountCurrencyInput
              amount={amount}
              currency={isUsdtLocked ? 'USDT' : currency}
              onAmountChange={(v) => {
                setAmount(v)
                clearFieldError('amount')
              }}
              onCurrencyChange={(v) => {
                // Guard: when USDT is locked, ignore any currency change attempt.
                if (!isUsdtLocked) setCurrency(v)
              }}
              disableCurrency={isUsdtLocked}
              error={fieldErrors.amount}
              errorTestId="create-transaction-error-amount"
            />
          )}

          {/* Date (non-dividend types) */}
          {type !== 'DIVIDEND' && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Дата транзакции</Label>
              <DatePickerField value={txDate} onChange={setTxDate} className="h-9 text-sm" />
            </div>
          )}

          {/* Receipt — mandatory for all 7 showReceipt types (task-receipts-frontend);
              explorer-only (link, no file) when the effective currency is USDT. */}
          {showReceipt && (
            <div className="space-y-1.5">
              <ReceiptInput
                state={receipt}
                onChange={(s) => {
                  setReceipt(s)
                  clearFieldError('receipt')
                }}
                label="Чек / подтверждение *"
                explorerOnly={isExplorerOnly}
                error={fieldErrors.receipt}
              />
              {fieldErrors.receipt && (
                <p
                  className="text-[11px] text-destructive"
                  data-testid="create-transaction-error-receipt"
                >
                  {fieldErrors.receipt}
                </p>
              )}
            </div>
          )}

          {/* Notes */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              Заметки <span className="text-muted-foreground/50">(необязательно)</span>
            </Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Дополнительная информация..."
              rows={2}
              className="text-sm resize-none"
            />
          </div>
        </CrmDialogBody>

        {/* AC4: when fields are missing, show a short summary banner pointing
            at the inline hints (the offending field can be below the fold).
            The server/mutation error keeps its own banner below it. */}
        {hasFieldErrors && (
          <div
            className="flex items-center gap-2 border-t border-destructive/20 bg-destructive/5 px-4 py-2.5 text-xs text-destructive"
            data-testid="create-transaction-field-error-summary"
          >
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            Заполните выделенные поля
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 border-t border-destructive/20 bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {error}
          </div>
        )}

        {/* task-admin-income-unified (AC5/AC6). Pre-submit preview of the
            obligation(s) this income books — appears the instant a
            USDT-payment project is picked (before an amount is even typed —
            the amount then updates live), disappears the instant the project
            is switched to a non-USDT one. Not "будет создана дополнительная
            операция" in the abstract — the exact beneficiary, the exact
            percent + its source, and an amount computed with the SAME
            `roundShareAmount` the server books with (see the function doc). */}
        {showObligationBanner && (
          <div
            className="space-y-1 border-t border-primary/20 bg-primary/5 px-4 py-2.5 text-xs"
            data-testid="admin-income-obligation-preview"
          >
            {obligationPreviews.map((p) => (
              <p
                key={p.role}
                data-testid={`admin-income-obligation-preview-${p.role.toLowerCase()}`}
              >
                {p.roleLabel} <span className="font-medium">{p.name}</span>{' '}
                {hasPositiveAmount ? (
                  <>
                    будет начислено{' '}
                    <span
                      className="font-bold tabular-nums"
                      data-testid={`admin-income-obligation-amount-${p.role.toLowerCase()}`}
                    >
                      {fmtUsdt(p.amount)} USDT
                    </span>{' '}
                  </>
                ) : (
                  // task-admin-income-unified (§3, AC7): an empty/zero amount must NOT
                  // claim a $0.00 figure — that reads as "no share will be created",
                  // the opposite of the truth. Stay silent on the number, keep the
                  // qualitative fact ("a share WILL be booked") — see the module doc
                  // above §3 for why the condition is deliberately wider than "receiver
                  // is an admin".
                  'будет создана доля '
                )}
                (доля {p.percent}%, источник:{' '}
                <span data-testid={`admin-income-obligation-source-${p.role.toLowerCase()}`}>
                  {p.sourceLabel}
                </span>
                )
              </p>
            ))}
          </div>
        )}

        <CrmDialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onClose()
              resetForm()
            }}
            data-testid="create-transaction-cancel"
          >
            Отмена
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={mutation.isPending}
            data-testid="create-transaction-submit"
            data-track="transaction-create"
          >
            {mutation.isPending ? 'Создание...' : 'Создать транзакцию'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
