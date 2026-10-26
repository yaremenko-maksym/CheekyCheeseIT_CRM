import { ArrowLeftRight, ArrowRight } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'
import type { UserOption } from './shared'

// Admin transfer — swap UI.
export function TransferSwapField({
  transferSender,
  transferReceiver,
  swapTransfer,
}: {
  transferSender: UserOption | undefined
  transferReceiver: UserOption | undefined
  swapTransfer?: (() => void) | undefined
}) {
  const { t } = useLingui()
  const Card = swapTransfer ? 'button' : 'div'
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">
        <Trans>Напрямок переказу</Trans>
      </Label>
      <div className="flex items-center gap-2">
        {/* Sender card */}
        <Card
          type={swapTransfer ? 'button' : undefined}
          onClick={swapTransfer}
          className={cn(
            'flex-1 flex flex-col items-center gap-1 rounded-lg border px-3 py-2.5 transition-all text-center',
            'border-border bg-muted/20',
            swapTransfer && 'hover:bg-muted/40',
          )}
          // Stryker disable next-line StringLiteral: `title` tooltip attribute, not asserted by any test in this suite (the card's own click behaviour is tested via `swapTransfer`, not this hover hint).
          title={swapTransfer ? t`Натисніть, щоб змінити напрямок` : undefined}
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
        </Card>

        {/* Swap button */}
        {swapTransfer ? (
          <button
            type="button"
            onClick={swapTransfer}
            className="shrink-0 h-8 w-8 rounded-full border border-border bg-muted/30 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-all hover:rotate-180 duration-300"
            // Stryker disable next-line StringLiteral: `title` tooltip attribute, not asserted by any test in this suite.
            title={t`Поміняти напрямок`}
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
          </button>
        ) : (
          <ArrowRight aria-hidden="true" className="shrink-0 h-4 w-4 text-muted-foreground" />
        )}

        {/* Receiver card */}
        <Card
          type={swapTransfer ? 'button' : undefined}
          onClick={swapTransfer}
          className={cn(
            'flex-1 flex flex-col items-center gap-1 rounded-lg border px-3 py-2.5 transition-all text-center',
            'border-border bg-muted/20',
            swapTransfer && 'hover:bg-muted/40',
          )}
          // Stryker disable next-line StringLiteral: `title` tooltip attribute, not asserted by any test in this suite.
          title={swapTransfer ? t`Натисніть, щоб змінити напрямок` : undefined}
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
        </Card>
      </div>
      {swapTransfer && (
        <p className="text-[10px] text-muted-foreground/60 text-center">
          <Trans>Натисніть на картки або стрілку, щоб змінити напрямок</Trans>
        </p>
      )}
    </div>
  )
}
