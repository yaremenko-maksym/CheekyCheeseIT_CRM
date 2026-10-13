import { Trans } from '@lingui/react/macro'
import type { ObligationPreview } from './shared'

// task-admin-income-unified (AC5/AC6). Pre-submit preview of the obligation(s)
// this income books — the exact beneficiary, the exact percent + its source, and
// an amount computed with the SAME `roundShareAmount` the server books with (see
// `computeObligationPreviews`).
export function ObligationPreviewBanner({
  obligationPreviews,
  hasPositiveAmount,
  fmtUsdt,
}: {
  obligationPreviews: ObligationPreview[]
  hasPositiveAmount: boolean
  fmtUsdt: (n: number) => string
}) {
  return (
    <div
      className="space-y-1 border-t border-primary/20 bg-primary/5 px-4 py-2.5 text-xs"
      data-testid="admin-income-obligation-preview"
    >
      {obligationPreviews.map((p) => (
        <p key={p.role} data-testid={`admin-income-obligation-preview-${p.role.toLowerCase()}`}>
          {p.roleLabel} <span className="font-medium">{p.name}</span>{' '}
          {hasPositiveAmount ? (
            <Trans>
              буде нараховано{' '}
              <span
                className="font-bold tabular-nums"
                data-testid={`admin-income-obligation-amount-${p.role.toLowerCase()}`}
              >
                {fmtUsdt(p.amount)} USDT
              </span>{' '}
            </Trans>
          ) : (
            // task-admin-income-unified (§3, AC7): an empty/zero amount must NOT
            // claim a $0.00 figure — that reads as "no share will be created",
            // the opposite of the truth. Stay silent on the number, keep the
            // qualitative fact ("a share WILL be booked") — see the module doc
            // above §3 for why the condition is deliberately wider than "receiver
            // is an admin".
            <Trans>буде створена частка </Trans>
          )}
          <Trans>
            (частка {p.percent}%, джерело:{' '}
            <span data-testid={`admin-income-obligation-source-${p.role.toLowerCase()}`}>
              {p.sourceLabel}
            </span>
            )
          </Trans>
        </p>
      ))}
    </div>
  )
}
