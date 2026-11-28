import { ArrowRight } from 'lucide-react'
import { Trans } from '@lingui/react/macro'
import { Label } from '@/components/ui/label'
import type { UserOption } from './shared'

// Admin transfer — read-only direction (the caller ADMIN always sends).
export function TransferSwapField({
  transferSender,
  transferReceiver,
}: {
  transferSender: UserOption | undefined
  transferReceiver: UserOption | undefined
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">
        <Trans>Напрямок переказу</Trans>
      </Label>
      <div className="flex items-center gap-2">
        {/* Sender card */}
        <div
          data-testid="transfer-sender-card"
          className="flex-1 flex flex-col items-center gap-1 rounded-lg border px-3 py-2.5 transition-all text-center border-border bg-muted/20"
        >
          <div className="h-8 w-8 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-sm font-bold text-primary">
            {transferSender?.displayName.charAt(0) ?? '?'}
          </div>
          <span className="text-xs font-medium leading-tight">
            {transferSender?.displayName ?? '—'}
          </span>
          <span className="text-[10px] text-muted-foreground">
            <Trans>надсилає</Trans>
          </span>
        </div>

        <ArrowRight aria-hidden="true" className="shrink-0 h-4 w-4 text-muted-foreground" />

        {/* Receiver card */}
        <div
          data-testid="transfer-receiver-card"
          className="flex-1 flex flex-col items-center gap-1 rounded-lg border px-3 py-2.5 transition-all text-center border-border bg-muted/20"
        >
          <div className="h-8 w-8 rounded-full bg-muted/40 border border-border flex items-center justify-center text-sm font-bold text-muted-foreground">
            {transferReceiver?.displayName.charAt(0) ?? '?'}
          </div>
          <span className="text-xs font-medium leading-tight">
            {transferReceiver?.displayName ?? '—'}
          </span>
          <span className="text-[10px] text-muted-foreground">
            <Trans>отримує</Trans>
          </span>
        </div>
      </div>
    </div>
  )
}
