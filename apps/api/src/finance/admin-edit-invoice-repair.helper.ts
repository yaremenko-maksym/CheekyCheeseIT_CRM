import type { Logger } from '@nestjs/common'
import type { DatabaseService } from '../database/database.service'
import { transactionAuditLog, type transactions } from '../database/schema'
import type { InvoiceReissueOutcome, InvoicesService } from '../invoices/invoices.service'

/**
 * The post-commit invoice void/re-issue repair of
 * `AdminEditService.adminUpdateTransaction`, moved out unchanged (CR-M-5: the
 * service file outgrew the 800-line cap). Runs AFTER the edit's DB transaction
 * has committed, and never throws for an invoice or journal failure.
 */
export type AdminEditInvoiceRepairDeps = {
  db: DatabaseService
  invoicesService: InvoicesService
  logger: Logger
}

export type AdminEditResult = {
  id: string
  invoiceReissueIncomplete?: 'SELF_REPAIRABLE' | 'MANUAL_CHECK'
}

/**
 * SR-M-1 — which stage of an invoice void/re-issue failed, if any. `undefined`
 * (a caller or double that reports nothing) is not a failure: the only
 * failures are the ones someone actually reported.
 */
function invoiceFailureStage(
  outcome: InvoiceReissueOutcome | undefined,
): 'VOID' | 'REISSUE' | null {
  if (outcome === 'VOID_FAILED') return 'VOID'
  if (outcome === 'REISSUE_FAILED') return 'REISSUE'
  return null
}

/**
 * COPY-M-6 — only ever asked to pick a MESSAGE, on a path where something
 * has already failed. A throw here would replace a saved edit with a 500,
 * so an unanswerable question means «do not promise a repair».
 */
async function canRepairInvoiceQuietly(
  deps: AdminEditInvoiceRepairDeps,
  id: string,
): Promise<boolean> {
  try {
    return await deps.invoicesService.canRepairSalaryInvoice(id)
  } catch (err) {
    deps.logger.error(
      `adminUpdateTransaction: could not determine invoice repairability for transaction=${id}: ${(err as Error).message}`,
    )
    return false
  }
}

// task-cascade-apply (task 3, AC11) — an amount edit invalidates every
// invoice built on the old figure. `voidAndReissueInvoiceForAmountEdit`
// (task 4, PR #600) marks the signed document void and issues a fresh one;
// this is its first and only caller.
//
// OUTSIDE the DB transaction on purpose: that method opens its OWN
// transaction with `FOR UPDATE`, so calling it from inside this one would
// self-deadlock. A PDF/S3 hiccup must not undo a cascade that has already
// committed — so a failure does not throw.
//
// SR-M-1 (security-review, PR #721): but it is no longer SILENT either.
// Before, a failed void left the old, counterparty-signed invoice live
// (the public QR check still confirmed the old figure) and a failed
// re-issue left a salary with no invoice forever — both visible only in
// the server log. Now each failure is a journal line
// (`INVOICE_REISSUE_FAILED`) and the response carries
// `invoiceReissueIncomplete`, so the edit is not reported as a clean
// success. And the repair exists: re-saving a PAID salary whose invoice
// was voided and never replaced re-issues it (below).
export async function repairInvoicesAfterAdminEdit(
  deps: AdminEditInvoiceRepairDeps,
  input: {
    id: string
    tx: typeof transactions.$inferSelect
    actorId: string
    cascadeApplied: { changedDerivativeIds: string[] } | undefined
    dateMoved: boolean
  },
): Promise<AdminEditResult> {
  const { id, tx, actorId, cascadeApplied } = input
  const failedStages: Array<{ id: string; stage: 'VOID' | 'REISSUE' }> = []
  // SR-M-1 (owner decision, 2026-11-01): the invoice PDF is stamped from
  // `tx_date`, so a date move voids the counterparty-signed document and
  // issues a fresh one — the same path an amount cascade takes. A row with no
  // invoice answers `NOT_NEEDED`.
  const reissueIds = cascadeApplied
    ? [id, ...cascadeApplied.changedDerivativeIds]
    : input.dateMoved
      ? [id]
      : []
  if (reissueIds.length > 0) {
    for (const reissueId of reissueIds) {
      let outcome: InvoiceReissueOutcome | undefined
      try {
        outcome = await deps.invoicesService.voidAndReissueInvoiceForAmountEdit(reissueId, actorId)
      } catch (invoiceErr) {
        deps.logger.error(
          `adminUpdateTransaction: invoice void+reissue failed for transaction=${reissueId}: ${(invoiceErr as Error).message}`,
          (invoiceErr as Error).stack,
        )
        outcome = 'VOID_FAILED'
      }
      const stage = invoiceFailureStage(outcome)
      if (stage) failedStages.push({ id: reissueId, stage })
    }
  } else if (tx.type === 'SALARY' && tx.status === 'PAID') {
    // «Повторное сохранение чинит»: a save that did not move the amount is
    // the operator's way back to an invoice an earlier edit left broken —
    // whether the void failed (the old signed document is still current) or
    // the re-issue did (no document at all). SR-M-3: both stages, so the
    // toast's advice is actionable in either. A salary that never had an
    // invoice is left alone (see the method).
    let outcome: InvoiceReissueOutcome | undefined
    try {
      outcome = await deps.invoicesService.reissueSalaryInvoiceIfVoided(id, actorId)
    } catch (invoiceErr) {
      deps.logger.error(
        `adminUpdateTransaction: salary invoice repair failed for transaction=${id}: ${(invoiceErr as Error).message}`,
      )
      outcome = 'REISSUE_FAILED'
    }
    const stage = invoiceFailureStage(outcome)
    if (stage) failedStages.push({ id, stage })
  }

  // SR-L-5 (security-review round 2) — fire-and-forget, like every other
  // audit write in this file. The edit itself is already committed: letting
  // a journal failure throw would turn a saved edit into a 500 AND lose the
  // `invoiceReissueIncomplete` flag, which is the one thing that tells the
  // operator to save again.
  for (const failed of failedStages) {
    try {
      await deps.db.db.insert(transactionAuditLog).values({
        actorId,
        targetId: failed.id,
        action: 'INVOICE_REISSUE_FAILED',
        metadata: { stage: failed.stage },
      })
    } catch (journalErr) {
      deps.logger.error(
        `adminUpdateTransaction: could not journal INVOICE_REISSUE_FAILED for transaction=${failed.id} (stage=${failed.stage}): ${(journalErr as Error).message}`,
      )
    }
  }

  if (failedStages.length === 0) return { id }
  // COPY-M-6 — «save it again» is true for the EDITED salary's own invoice
  // and false for a derived row, where no repair path exists at all. Asking
  // the invoice service keeps the promise tied to what it will actually do,
  // instead of to which row happened to fail.
  const onlyThisRow = failedStages.every((f) => f.id === id)
  const repairable = onlyThisRow && (await canRepairInvoiceQuietly(deps, id))
  return {
    id,
    invoiceReissueIncomplete: repairable ? ('SELF_REPAIRABLE' as const) : ('MANUAL_CHECK' as const),
  }
}
