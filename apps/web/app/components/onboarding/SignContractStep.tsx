import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, FileText, Loader2 } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import { API_ERROR_MESSAGES, type SignedContractDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { getApiErrorCode, getApiErrorMessage } from '@/lib/axios-utils'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** Derives 1–2 uppercase initials from a display/legal name. */
function getInitials(name: string | null | undefined): string {
  if (!name?.trim()) return '?'
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return (parts[0]?.[0] ?? '?').toUpperCase()
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase()
}

/**
 * Бэклог 212. Тот же текст, что отдаёт сервер в 403 на `POST
 * /contracts/sign` (`API_ERROR_MESSAGES.CONTRACT_SIGN_IMPERSONATION`,
 * шаблон G task-i18n-stage3b) — резолвится через `i18n._()` внутри
 * компонента, каталожный текст уже без завершающей точки.
 */
const IMPERSONATION_EXPLANATION_ID = 'sign-contract-explain-impersonating'

interface SignContractStepProps {
  onSuccess: () => void
}

export function SignContractStep({ onSuccess }: SignContractStepProps) {
  const { t, i18n } = useLingui()
  const { user } = useAuth()
  const [confirmed, setConfirmed] = useState(false)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [isLoadingPdf, setIsLoadingPdf] = useState(true)
  const [pdfError, setPdfError] = useState(false)
  const queryClient = useQueryClient()

  const legalNameMissing = !user?.legalFullName?.trim()
  const displayName = user?.legalFullName || user?.displayName || ''
  /** Бэклог 212 — под «войти как» подпись должен поставить сам сотрудник. */
  const impersonating = Boolean(user?.impersonating)

  // Fetch the preview PDF once user is available. The endpoint is bypass-listed
  // in OnboardingGuard so it works mid-onboarding (spec §2.1).
  useEffect(() => {
    if (!user) return

    let objectUrl: string | null = null
    let cancelled = false

    setIsLoadingPdf(true)
    setPdfError(false)
    setBlobUrl(null)

    void api
      .get('/onboarding/contract/pdf', { responseType: 'blob' })
      .then((res) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(res.data as Blob)
        setBlobUrl(objectUrl)
      })
      .catch(() => {
        if (cancelled) return
        setIsLoadingPdf(false)
        setPdfError(true)
      })

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [user])

  const signMutation = useMutation<SignedContractDto, Error, void>({
    mutationFn: async () => {
      const res = await api.post<SignedContractDto>('/contracts/sign', {})
      return res.data
    },
    onSuccess: async (data) => {
      toast.success(t`Контракт підписано, номер ${data.contractNumber}`)
      await queryClient.invalidateQueries({ queryKey: ['onboarding-status'] })
      onSuccess()
    },
    onError: (err: unknown) => {
      // task-i18n-stage4-task3: the server's refusal now carries a stable
      // `code` (see `apps/api/src/contracts/signed-contracts.service.ts`)
      // instead of English prose to substring-match — the old
      // `message.includes('LEGAL_NAME_REQUIRED')` broke the moment that
      // prose became translatable (same class of fix as `ContractTab.tsx`'s
      // `CONTRACT_TEMPLATE_MISSING` — see its comment for why `.includes()`
      // on `err.message` cannot survive a client-side catalog translation).
      const code = getApiErrorCode(err)
      if (code === 'LEGAL_NAME_REQUIRED') {
        toast.error(getApiErrorMessage(err))
        return
      }
      if (code === 'ADMIN_DOES_NOT_SIGN_CONTRACTS') {
        toast.info(getApiErrorMessage(err))
        return
      }
      toast.error(t`Не вдалося підписати контракт`)
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    signMutation.mutate()
  }

  const isSignDisabled =
    !confirmed ||
    !blobUrl ||
    pdfError ||
    legalNameMissing ||
    impersonating ||
    signMutation.isPending

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5" data-testid="sign-contract-form">
      {/* Heading */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">
            <Trans>Ваш контракт</Trans>
          </span>
        </div>
        <Badge variant="outline" className="text-[10px] text-muted-foreground">
          <Trans>Попередній перегляд</Trans>
        </Badge>
      </div>

      {/* PDF viewer region */}
      <div role="region" aria-label={t`Контракт для підписання`}>
        <div
          className="relative w-full rounded-md border border-border bg-muted/20"
          style={{ height: '480px' }}
        >
          {/* Loading overlay */}
          {isLoadingPdf && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-md bg-muted/30">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                <Trans>Завантаження контракту…</Trans>
              </p>
            </div>
          )}

          {/* PDF iframe (PD-1=B: nested <object> для iOS progressive enhancement) */}
          {blobUrl && !pdfError && (
            <iframe
              src={blobUrl}
              title={t`Попередній перегляд персонального контракту`}
              aria-label={t`Попередній перегляд персонального контракту`}
              aria-describedby="pdf-sr-note"
              tabIndex={0}
              className={cn('w-full h-full rounded-md border-0', isLoadingPdf && 'invisible')}
              onLoad={() => setIsLoadingPdf(false)}
              onError={() => {
                setIsLoadingPdf(false)
                setPdfError(true)
              }}
            >
              {/* Progressive enhancement fallback for iOS Safari */}
              <object data={blobUrl} type="application/pdf" className="w-full h-full">
                <p className="p-4 text-sm text-muted-foreground">
                  <Trans>
                    Вбудований перегляд PDF недоступний.{' '}
                    <a
                      href={blobUrl}
                      download={t`Контракт — попередній перегляд.pdf`}
                      className="underline hover:text-foreground"
                    >
                      Завантажити контракт
                    </a>
                  </Trans>
                </p>
              </object>
            </iframe>
          )}

          {/* Empty / not yet fetched placeholder */}
          {!blobUrl && !isLoadingPdf && !pdfError && (
            <div className="flex h-full items-center justify-center">
              <FileText className="h-10 w-10 text-muted-foreground" />
            </div>
          )}
        </div>

        {/* SR-only fallback note for screen-readers */}
        <p id="pdf-sr-note" className="sr-only">
          <Trans>
            PDF-документ. За потреби скористайтеся кнопкою «Завантажити для перегляду» нижче, щоб
            переглянути контракт у зовнішній програмі
          </Trans>
        </p>

        {/* Download link for a11y + edge-cases */}
        {blobUrl && !pdfError && (
          <div className="mt-1 flex justify-end">
            <a
              href={blobUrl}
              download={t`Контракт — попередній перегляд.pdf`}
              className="text-xs text-muted-foreground underline hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
            >
              <Trans>Завантажити для перегляду</Trans>
            </a>
          </div>
        )}
      </div>

      {/* PDF error state */}
      {pdfError && (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
          data-testid="pdf-error"
        >
          <AlertTriangle className="inline h-4 w-4 mr-2" />
          <Trans>
            Не вдалося завантажити попередній перегляд контракту — зверніться до адміністратора
          </Trans>
        </div>
      )}

      {/* Info alert */}
      <p className="rounded-md border border-border bg-muted/10 px-4 py-3 text-sm text-muted-foreground">
        <Trans>
          Дані в контракті — ім’я, email і реквізити — задає адміністратор; якщо щось не так,
          напишіть йому
        </Trans>
      </p>

      {/* Checkbox — h-6 w-6 per WCAG SC 2.5.8 (24×24px target) */}
      <label
        className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 transition-colors hover:bg-muted/40"
        data-testid="confirm-checkbox-label"
      >
        <input
          type="checkbox"
          data-testid="confirm-checkbox"
          className="mt-0.5 h-6 w-6 accent-primary"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          aria-describedby="contract-checkbox-hint"
        />
        <span id="contract-checkbox-hint" className="text-sm leading-snug">
          <Trans>Умови персонального контракту прочитано — підтверджую</Trans>
        </span>
      </label>

      {/* Missing legalFullName guard alert (PD-4=A) */}
      {legalNameMissing && (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
          data-testid="legal-name-missing-alert"
        >
          <AlertTriangle className="inline h-4 w-4 mr-2" />
          <Trans>
            Юридичне ПІБ не заповнено — підписання відкриється, щойно його заповнить адміністратор
          </Trans>
        </div>
      )}

      {/* Бэклог 212 — под «войти как» подпись недоступна; тот же текст,
          что отдаёт сервер в 403 на POST /contracts/sign (шаблон G). */}
      {impersonating && (
        <div
          id={IMPERSONATION_EXPLANATION_ID}
          role="alert"
          aria-live="assertive"
          data-testid="sign-contract-impersonating-banner"
          className="rounded-md border border-amber-300/30 bg-amber-300/5 p-4 text-sm text-amber-300"
        >
          <AlertTriangle className="inline h-4 w-4 mr-2" />
          {i18n._(API_ERROR_MESSAGES.CONTRACT_SIGN_IMPERSONATION)}
        </div>
      )}

      {/* Read-only signature block */}
      <div
        className="flex items-center gap-3 rounded-md border border-border bg-muted/20 px-4 py-3"
        role="group"
        aria-label={t`Підписант`}
        data-testid="signature-block"
      >
        <Avatar className="h-8 w-8 shrink-0">
          <AvatarFallback className="text-xs">{getInitials(displayName)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium leading-none">{displayName || '—'}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            <Trans>Підпис — юридичне ПІБ з профілю</Trans>
          </p>
        </div>
      </div>

      {/* Submit button */}
      <Tooltip>
        <TooltipTrigger asChild>
          {/* span wrapper allows Tooltip to target a disabled button */}
          <span className="w-full">
            <Button
              type="submit"
              data-testid="sign-button"
              disabled={isSignDisabled}
              aria-disabled={isSignDisabled}
              aria-describedby={impersonating ? IMPERSONATION_EXPLANATION_ID : undefined}
              className="w-full"
            >
              {signMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  <Trans>Підписання…</Trans>
                </>
              ) : (
                <Trans>Підписати контракт</Trans>
              )}
            </Button>
          </span>
        </TooltipTrigger>
        {legalNameMissing && (
          <TooltipContent>
            <Trans>
              Юридичне ПІБ заповнює адміністратор — напишіть йому, і підписання відкриється одразу
              після цього
            </Trans>
          </TooltipContent>
        )}
      </Tooltip>
    </form>
  )
}
