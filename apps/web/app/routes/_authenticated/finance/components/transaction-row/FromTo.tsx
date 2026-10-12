import { ArrowRight } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { useLingui } from '@lingui/react/macro'
import type { TransactionDto } from '@crm/shared'
import { withLocalizedCompanyLabels } from '../counterparty-label'

// A party (sender or receiver) — clickable if it's a known user or project
export function Party({
  id,
  name,
  label,
  type,
}: {
  id: string | null | undefined
  name: string | null | undefined
  label: string | null | undefined
  type: 'user' | 'project'
}) {
  const display = name ?? label ?? '—'

  if (id && name) {
    if (type === 'user') {
      return (
        <Link
          to="/profile/$userId"
          params={{ userId: id }}
          className="text-primary hover:underline underline-offset-2 font-medium break-words max-w-44 block"
          title={display}
          onClick={(e) => e.stopPropagation()}
        >
          {display}
        </Link>
      )
    }
    return (
      <Link
        to="/projects/$projectId"
        params={{ projectId: id }}
        className="text-primary hover:underline underline-offset-2 font-medium break-words max-w-44 block"
        title={display}
        onClick={(e) => e.stopPropagation()}
      >
        {display}
      </Link>
    )
  }

  // Non-clickable alias (e.g. CheekyCheeseIT, company name)
  return (
    <span className="text-muted-foreground break-words max-w-44 block" title={display}>
      {display}
    </span>
  )
}

// server-text PR3: the backend books the company account as the raw code
// (`COMPANY_ACCOUNT_LABEL`) in sender/receiver labels. `FromTo` localizes it ONCE
// up front (see `withLocalizedCompanyLabels`), so every case below can read
// `tx.senderLabel` / `tx.receiverLabel` as display text. `CheekyCheeseIT` is the
// product's own brand name, not a translatable phrase (`russian-language.md`
// proper-noun carve-out) — it stays as a literal on both locales.
export function FromTo({ tx: rawTx }: { tx: TransactionDto }) {
  const { t } = useLingui()
  const companyLabel = t`Рахунок компанії`
  const tx = withLocalizedCompanyLabels(rawTx, companyLabel)
  switch (tx.type) {
    case 'ADMIN_INCOME':
    case 'SENIOR_INCOME':
      // Company (client) → Senior who created the transaction
      // sender_label = client company name, receiver_id = senior user
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party
            id={null}
            name={null}
            label={tx.senderLabel ?? tx.projectName ?? '—'}
            type="project"
          />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <Party id={tx.receiverId} name={tx.receiverName} label={tx.receiverLabel} type="user" />
        </div>
      )

    case 'EXPENSE':
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party id={tx.senderId} name={tx.senderName} label={tx.senderLabel} type="user" />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <Party id={null} name={null} label={tx.receiverLabel ?? '—'} type="user" />
        </div>
      )

    case 'SALARY':
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party
            id={tx.senderId}
            name={tx.senderName}
            label={tx.senderLabel ?? 'CheekyCheeseIT'}
            type="user"
          />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <Party id={tx.receiverId} name={tx.receiverName} label={tx.receiverLabel} type="user" />
        </div>
      )

    case 'ADMIN_TRANSFER':
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party id={tx.senderId} name={tx.senderName} label={tx.senderLabel} type="user" />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <Party id={tx.receiverId} name={tx.receiverName} label={tx.receiverLabel} type="user" />
        </div>
      )

    case 'PAYOUT':
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party id={tx.senderId} name={tx.senderName} label={tx.senderLabel} type="user" />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <Party id={null} name={null} label={tx.receiverLabel ?? 'CheekyCheeseIT'} type="user" />
        </div>
      )

    // PAYOUT_ADMIN shares the PAYOUT_CONFIRMED body (the two arms were byte-identical).
    case 'PAYOUT_ADMIN':
    // Drop role - phase 3 (spec §8.4). Sender mirrors the original PAYOUT
    // (drop / senior). Receiver is the admin partner chosen during manual
    // confirmation — surfaced through receiverId/receiverName.
    case 'PAYOUT_CONFIRMED':
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party id={tx.senderId} name={tx.senderName} label={tx.senderLabel} type="user" />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <Party id={tx.receiverId} name={tx.receiverName} label={tx.receiverLabel} type="user" />
        </div>
      )

    // The company owes a senior their drop-project share. The row is booked with
    // senderLabel='COMPANY' (no senderId) and receiverId = the senior, so the
    // sender renders as the non-clickable company alias and the receiver as the
    // clickable senior — instead of the previous «—» default.
    // (SENIOR_PENDING_PAYOUT shares the DROP_PENDING_PAYOUT body — byte-identical arms.)
    case 'SENIOR_PENDING_PAYOUT':
    // Manual QA #367 fix: mirror of SENIOR_PENDING_PAYOUT above — the company
    // owes a drop their USDT-project share (booked by bookCompanyObligations,
    // same row shape: senderLabel='COMPANY', receiverId = the drop). Without
    // this case the row fell through to `default` and rendered a bare "—"
    // (no participant at all), unlike the senior row right above it.
    case 'DROP_PENDING_PAYOUT':
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party id={null} name={null} label={tx.senderLabel ?? 'CheekyCheeseIT'} type="user" />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <Party id={tx.receiverId} name={tx.receiverName} label={tx.receiverLabel} type="user" />
        </div>
      )

    // Drop registers project income: client company → drop. The row is booked
    // with senderLabel = client company name (no senderId) and receiverId = the
    // drop, so the sender renders as the non-clickable client alias and the
    // receiver as the clickable drop — instead of the previous «—» default.
    case 'DROP_INCOME':
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party id={tx.senderId} name={tx.senderName} label={tx.senderLabel} type="user" />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <Party id={tx.receiverId} name={tx.receiverName} label={tx.receiverLabel} type="user" />
        </div>
      )

    // fix/payout-drop-from-to: the auto-created drop share credited after
    // payPayoutRequest on a drop-project settles (see
    // PendingSettlementService.settleByCompany). Sender mirrors the funding
    // source: COMPANY_ACCOUNT/legacy rows carry senderId=null +
    // senderLabel='COMPANY' (non-clickable alias), ADMIN_PERSONAL rows carry
    // a real senderId/senderName (the admin who personally funded it) —
    // Party handles both via the same id-presence check. Receiver is always
    // the drop. Without this case the row fell through to `default` and
    // rendered a bare «—», same class of bug as DROP_PENDING_PAYOUT above.
    case 'PAYOUT_DROP':
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party
            id={tx.senderId}
            name={tx.senderName}
            label={tx.senderLabel ?? 'CheekyCheeseIT'}
            type="user"
          />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <Party id={tx.receiverId} name={tx.receiverName} label={tx.receiverLabel} type="user" />
        </div>
      )

    // fix/payout-drop-from-to (audit pass, AC2): two more LIVE money types
    // that insert real rows into `transactions` (CompanyAccountService) and
    // are visible to ADMIN/ACCOUNTANT in the unfiltered findAll() list, yet
    // had no FromTo case — same bare-«—» bug as PAYOUT_DROP above.
    //
    // COMPANY_DEPOSIT: a SENIOR/DROP submits a verified USDT deposit onto the
    // shared company wallet (submitDeposit). senderId/senderName = the
    // submitter (clickable), receiverId=null + receiverLabel=COMPANY code.
    case 'COMPANY_DEPOSIT':
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party id={tx.senderId} name={tx.senderName} label={tx.senderLabel} type="user" />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <Party id={null} name={null} label={tx.receiverLabel ?? companyLabel} type="user" />
        </div>
      )

    // DIVIDEND_TO_ADMIN: ADMIN withdraws dividends from the company account
    // (createDividend). senderId=null + senderLabel=COMPANY code (company
    // alias, non-clickable), receiverId = the admin (clickable).
    case 'DIVIDEND_TO_ADMIN':
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party id={null} name={null} label={tx.senderLabel ?? companyLabel} type="user" />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <Party id={tx.receiverId} name={tx.receiverName} label={tx.receiverLabel} type="user" />
        </div>
      )

    // Intentionally «—»: Phase 4-B placeholder types (TOV_INCOME, SENIOR_PAID,
    // ADMIN_INCOME_CASH, ADMIN_INCOME_CRYPTO, SENIOR_INCOME_CRYPTO,
    // DIVIDEND_TAX) exist only to satisfy the exhaustive TYPE_LABEL_MESSAGES/
    // TYPE_COLORS Record<> contracts — no current flow ever inserts a row
    // with these types (verified against every `.insert(transactions)` call
    // site), so falling through to the dash here is correct, not a bug.
    default:
      return <span className="text-muted-foreground">—</span>
  }
}
