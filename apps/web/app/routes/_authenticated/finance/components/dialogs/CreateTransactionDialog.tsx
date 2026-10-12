import React, { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import { SALARY_ELIGIBLE_ROLES, COMPANY_ACCOUNT_RECEIVER, formatNumber } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { useLocale } from '@/lib/i18n'
import { api } from '@/lib/axios'
import { getApiErrorMessage } from '@/lib/axios-utils'
import { trackFeatureClick } from '@/lib/telemetry'
import { parseStrictAmount } from '@/lib/utils'
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
import { Label } from '@/components/ui/label'
import { AmountCurrencyInput } from '@/components/ui/amount-currency-input'
import { Textarea } from '@/components/ui/textarea'
import { DatePickerField } from '@/components/ui/date-picker'
import { companyAccountApi } from '../../api'
import { emptyReceiptState, type ReceiptState } from '../ReceiptInput'
import {
  computeObligationPreviews,
  defaultSalaryMonth,
  getRate,
  needsConversion,
  type Currency,
  type DialogTxType,
  type ExchangeRate,
  type FundingSourceUI,
  type ProjectOption,
  type SalaryPrefill,
  type UserOption,
} from './create-transaction/shared'
import { AdminIncomeReceiverField } from './create-transaction/AdminIncomeReceiverField'
import { DividendFields } from './create-transaction/DividendFields'
import { ExpenseCategoryField } from './create-transaction/ExpenseCategoryField'
import { ObligationPreviewBanner } from './create-transaction/ObligationPreviewBanner'
import { ReceiptField } from './create-transaction/ReceiptField'
import { ProjectSelectSection } from './create-transaction/ProjectSelectSection'
import { renderFundingSourceToggle } from './create-transaction/renderFundingSourceToggle'
import { SalaryFields } from './create-transaction/SalaryFields'
import { TransferSwapField } from './create-transaction/TransferSwapField'
import { TypeSelector } from './create-transaction/TypeSelector'
import { useCreateTransactionMutation } from './create-transaction/useCreateTransactionMutation'
import { useCreateTransactionValidator } from './create-transaction/useCreateTransactionValidator'

// Kept importable from here (the obligation-preview unit test imports them).
export {
  computeObligationPreviews,
  type ObligationPreview,
  type ProjectOption,
} from './create-transaction/shared'

export function CreateTransactionDialog({
  open,
  onClose,
  salaryPrefill,
}: {
  open: boolean
  onClose: () => void
  salaryPrefill?: SalaryPrefill
}) {
  const { user } = useAuth()
  const qc = useQueryClient()
  const { t } = useLingui()
  const locale = useLocale()
  const fmtUsdt = (n: number): string =>
    formatNumber(n, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

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
  const [category, setCategory] = useState('')

  // task-salary-company-account / task-salary-pay-flow: funding source per-type.
  // EXPENSE / ADMIN_INCOME keep the company-account funding selector. SALARY no
  // longer picks a funding source HERE — it is created as a neutral PENDING
  // reminder; the funding source + currency are chosen later, at pay time
  // (PaySalaryDialog). So SALARY (like every other non-company type) defaults to
  // 'legacy' = "do not send fundingSource in payload".
  const defaultFundingSource = (txType: DialogTxType): FundingSourceUI => {
    // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator,StringLiteral: both branches return the identical literal 'legacy' — the condition is provably unobservable by construction, same reasoning already applied at every OTHER call site of this function in this file (see the neighbouring suppressions on `setFundingSource(defaultFundingSource(...))` calls).
    if (txType === 'EXPENSE' || txType === 'ADMIN_INCOME') return 'legacy'
    return 'legacy'
  }
  const [fundingSource, setFundingSource] = useState<FundingSourceUI>(
    defaultFundingSource(availableTypes[0] ?? 'SENIOR_INCOME'),
  )
  const [salaryMonth, setSalaryMonth] = useState(defaultSalaryMonth)
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
  const [salaryIdempotencyKey, setSalaryIdempotencyKey] = useState(() => crypto.randomUUID())
  const [txDate, setTxDate] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  })
  // AC4: per-field validation errors keyed by field name. Populated on submit
  // so the user sees EVERY missing/invalid field at once (project, receipt,
  // amount, …) inline next to the field, instead of only the first failure in
  // a single bottom banner.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open || !salaryPrefill) return
    setType('SALARY')
    setReceiverId(salaryPrefill.receiverId)
    setSalaryMonth(salaryPrefill.salaryMonth)
    setCurrency(salaryPrefill.currency)
    setAmount('')
    setFieldErrors({})
  }, [open, salaryPrefill?.receiverId, salaryPrefill?.salaryMonth, salaryPrefill?.currency])

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

  const validate = useCreateTransactionValidator({
    amount,
    receipt,
    type,
    projectId,
    showReceipt,
    effectiveCurrency,
    isAdmin,
    receiverId,
    transferReceiverId,
    dividendReceiverId,
    companyBalance,
  })

  const mutation = useCreateTransactionMutation({
    qc,
    type,
    amount,
    receipt,
    isSelectedProjectUsdt,
    projectId,
    receiverId,
    usdtIncomeIdempotencyKey,
    notes,
    txDate,
    isUsdtLocked,
    currency,
    isAdmin,
    fundingSource,
    seniorIncomeIdempotencyKey,
    dropIncomeIdempotencyKey,
    category,
    salaryMonth,
    salaryIdempotencyKey,
    effectiveTransferSenderId,
    transferReceiverId,
    dividendIdempotencyKey,
    dividendReceiverId,
    isAdminIncomeCompanyFunded,
    onClose,
    resetForm,
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
    setCategory('')
    setSalaryMonth(defaultSalaryMonth())
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
    setSalaryIdempotencyKey(crypto.randomUUID())
  }

  const fundingToggleProps = {
    fundingSource,
    setFundingSource,
    setCurrency,
    companyBalance,
    fmtUsdt,
  }

  function handleProjectChange(v: string) {
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
  }

  function handleSelectType(txType: DialogTxType) {
    setType(txType)
    setProjectId('')
    setReceiverId('')
    // Also clear the ADMIN_TRANSFER sender so switching the type
    // inside an open dialog never leaves a stale party selected.
    setTransferSenderId('')
    setFieldErrors({})
    // Reset fundingSource to per-type default and restore the
    // default currency (any USDT-lock is re-derived from funding).
    setFundingSource(defaultFundingSource(txType))
    setCurrency('USD')
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
            {salaryPrefill ? (
              <Trans>Додати частину зарплати</Trans>
            ) : (
              <Trans>Нова транзакція</Trans>
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">
            <Trans>Створення транзакції</Trans>
          </DialogDescription>
        </CrmDialogHeader>

        <CrmDialogBody className="space-y-4 py-1">
          <TypeSelector
            availableTypes={availableTypes}
            type={type}
            onSelectType={handleSelectType}
          />

          <div className="h-px bg-border/60" />

          <ProjectSelectSection
            type={type}
            projectId={projectId}
            fieldErrors={fieldErrors}
            adminProjects={adminProjects}
            dropProjects={dropProjects}
            myProjects={myProjects}
            adminOwnProjects={adminOwnProjects}
            projects={projects}
            userId={user?.id}
            isAccountant={isAccountant}
            onProjectChange={handleProjectChange}
          />

          {type === 'ADMIN_INCOME' && isAdmin && (
            <AdminIncomeReceiverField
              receiverId={receiverId}
              setReceiverId={setReceiverId}
              clearFieldError={clearFieldError}
              fieldErrors={fieldErrors}
              adminUsers={adminUsers}
              isSelectedProjectUsdt={isSelectedProjectUsdt}
              companyBalance={companyBalance}
              fmtUsdt={fmtUsdt}
            />
          )}

          {type === 'SALARY' && (
            <SalaryFields
              receiverId={receiverId}
              setReceiverId={setReceiverId}
              clearFieldError={clearFieldError}
              fieldErrors={fieldErrors}
              salaryTargets={salaryTargets}
              salaryMonth={salaryMonth}
              setSalaryMonth={setSalaryMonth}
            />
          )}

          {/* Funding source selector — EXPENSE only (task-admin-income-unified
              §2: ADMIN_INCOME's ADMIN branch is the flat receiver Select above;
              its ACCOUNTANT branch is the constrained toggle right below).
              task-salary-pay-flow: SALARY has no funding selector here — chosen
              at pay time (PaySalaryDialog). */}
          {type === 'EXPENSE' &&
            renderFundingSourceToggle({
              ...fundingToggleProps,
              sectionLabel: t`Джерело коштів`,
              personalLabel: t`Звичайна витрата`,
              personalDescription: t`Стандартна витрата, не зачіпає рахунок компанії`,
              companyDescription: t`Списується з рахунку компанії (USDT)`,
            })}

          {/* task-admin-income-unified (§2, owner decision 2026-08-12).
              ACCOUNTANT's CONSTRAINED "Рахунок отримувача" — reuses the EXACT
              same `fundingSource` state/toggle shape EXPENSE uses above (no
              new state), but "personal" always means the PROJECT OWNER
              (never a picked admin, never the accountant — the server
              rejects anything else for this role, see createAdminIncome).
              The interface never offers what the server would reject. */}
          {type === 'ADMIN_INCOME' &&
            isAccountant &&
            renderFundingSourceToggle({
              ...fundingToggleProps,
              sectionLabel: t`Рахунок отримувача`,
              personalLabel: t`Власник проєкту`,
              // Урок #702, п.9 — ім'я підставляється тільки в називному відмінку:
              // «Дохід зарахується на рахунок адміністратора — {name}», не
              // «адміністратору {name}» (це вимагало б давального відмінка).
              personalDescription: selectedAdminProject?.seniorName
                ? t`Дохід зарахується на рахунок адміністратора — ${selectedAdminProject.seniorName}`
                : t`Дохід зарахується на рахунок адміністратора-власника проєкту`,
              companyDescription: t`Зарахується на рахунок компанії (USDT)`,
            })}

          {type === 'ADMIN_TRANSFER' && adminUsers.length >= 2 && (
            <TransferSwapField
              transferSender={transferSender}
              transferReceiver={transferReceiver}
              swapTransfer={swapTransfer}
            />
          )}

          {type === 'EXPENSE' && (
            <ExpenseCategoryField category={category} setCategory={setCategory} />
          )}

          {type === 'DIVIDEND' && (
            <DividendFields
              companyBalance={companyBalance}
              fmtUsdt={fmtUsdt}
              dividendReceiverId={dividendReceiverId}
              setReceiverId={setReceiverId}
              clearFieldError={clearFieldError}
              fieldErrors={fieldErrors}
              adminUsers={adminUsers}
              amount={amount}
              setAmount={setAmount}
            />
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

          {/* Business date — every manually-created transaction, including dividends. */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              <Trans>Дата транзакції</Trans>
            </Label>
            <DatePickerField value={txDate} onChange={setTxDate} className="h-9 text-sm" />
          </div>

          {showReceipt && (
            <ReceiptField
              receipt={receipt}
              setReceipt={setReceipt}
              clearFieldError={clearFieldError}
              fieldErrors={fieldErrors}
              isExplorerOnly={isExplorerOnly}
            />
          )}

          {/* Notes */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              <Trans>Примітки</Trans>
              {
                // Stryker disable next-line StringLiteral: whitespace separator before the "(необов’язково)" hint — rendering-whitespace detail, not asserted by any test.
                ' '
              }
              <span className="text-muted-foreground/50">
                <Trans>(необов’язково)</Trans>
              </span>
            </Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              // Stryker disable next-line StringLiteral: cosmetic placeholder for an optional field, not asserted by any test in this suite.
              placeholder={t`Додаткова інформація…`}
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
            <Trans>Заповніть виділені поля</Trans>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 border-t border-destructive/20 bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {error}
          </div>
        )}

        {showObligationBanner && (
          <ObligationPreviewBanner
            obligationPreviews={obligationPreviews}
            hasPositiveAmount={hasPositiveAmount}
            fmtUsdt={fmtUsdt}
          />
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
            <Trans>Скасувати</Trans>
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={mutation.isPending}
            data-testid="create-transaction-submit"
            data-track="transaction-create"
          >
            {
              // Stryker disable next-line StringLiteral: the pending-state label — every test in this suite mocks `useMutation` with a fixed `isPending: false`, so this branch never renders to be observed; the idle-state label is pinned by `CreateTransactionDialog.accountant.test.tsx`'s footer-copy test.
              mutation.isPending ? t`Створення…` : t`Створити транзакцію`
            }
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
