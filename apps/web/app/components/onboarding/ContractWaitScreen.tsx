import { Clock } from 'lucide-react'
import { Trans } from '@lingui/react/macro'

/**
 * ContractWaitScreen — A3-4 Task 5.
 *
 * Shown during the contract step when the user's personal employee_contract
 * exists but is still in DRAFT status (not yet READY_TO_SIGN). This means
 * the ADMIN is still preparing the contract body — the user must wait.
 *
 * Three-state matrix (onboarding status):
 *   requiresContract=true,  contractReady=false → this screen («Контракт готовится»)
 *   requiresContract=true,  contractReady=true  → SignContractStep (sign + PDF)
 *   requiresContract=false  (any contractReady) → contract step done → ToS
 *
 * The parent page polls GET /api/onboarding/status every 15s (refetchInterval).
 * Once the ADMIN marks the contract READY_TO_SIGN, contractReady flips to
 * true → the page re-renders SignContractStep automatically.
 */
export function ContractWaitScreen() {
  return (
    <div
      className="flex flex-col items-center gap-4 py-10 text-center"
      data-testid="contract-wait-screen"
    >
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
        <Clock className="h-8 w-8 text-muted-foreground" />
      </div>

      <div className="max-w-sm space-y-1.5">
        <h3 className="text-base font-semibold">
          <Trans>Контракт готується</Trans>
        </h3>
        <p className="text-sm text-muted-foreground">
          <Trans>
            Ваш персональний контракт ще не готовий до підписання — адміністратор заповнить його
            найближчим часом
          </Trans>
        </p>
        <p className="text-xs text-muted-foreground/70">
          <Trans>Сторінка оновиться сама, щойно контракт буде готовий</Trans>
        </p>
      </div>
    </div>
  )
}
