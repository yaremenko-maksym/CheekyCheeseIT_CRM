import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, FileText, Loader2 } from 'lucide-react'
import type { SignedContractDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
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

interface SignContractStepProps {
  onSuccess: () => void
}

export function SignContractStep({ onSuccess }: SignContractStepProps) {
  const { user } = useAuth()
  const [confirmed, setConfirmed] = useState(false)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [isLoadingPdf, setIsLoadingPdf] = useState(true)
  const [pdfError, setPdfError] = useState(false)
  const queryClient = useQueryClient()

  const legalNameMissing = !user?.legalFullName?.trim()
  const displayName = user?.legalFullName || user?.displayName || ''

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
      .get('/contracts/preview-pdf', { responseType: 'blob' })
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
      toast.success(`Контракт подписан. Номер: ${data.contractNumber}`)
      await queryClient.invalidateQueries({ queryKey: ['onboarding-status'] })
      onSuccess()
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('LEGAL_NAME_REQUIRED')) {
        toast.error('Юридическое ФИО не заполнено. Обратитесь к администратору.')
        return
      }
      if (message.includes('ADMIN_DOES_NOT_SIGN_CONTRACTS')) {
        toast.info('Админ не подписывает контракт')
        return
      }
      toast.error('Не удалось подписать контракт')
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    signMutation.mutate()
  }

  const isSignDisabled =
    !confirmed || !blobUrl || pdfError || legalNameMissing || signMutation.isPending

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5" data-testid="sign-contract-form">
      {/* Heading */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Ваш контракт</span>
        </div>
        <Badge variant="outline" className="text-[10px] text-muted-foreground">
          PREVIEW
        </Badge>
      </div>

      {/* PDF viewer region */}
      <div role="region" aria-label="Контракт для подписания">
        <div
          className="relative w-full rounded-md border border-border bg-muted/20"
          style={{ height: '480px' }}
        >
          {/* Loading overlay */}
          {isLoadingPdf && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-md bg-muted/30">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Загрузка контракта…</p>
            </div>
          )}

          {/* PDF iframe (PD-1=B: nested <object> для iOS progressive enhancement) */}
          {blobUrl && !pdfError && (
            <iframe
              src={blobUrl}
              title="Предварительный просмотр MSA-контракта"
              aria-label="Предварительный просмотр MSA-контракта"
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
                  Встроенный просмотр PDF недоступен.{' '}
                  <a
                    href={blobUrl}
                    download="contract-preview.pdf"
                    className="underline hover:text-foreground"
                  >
                    Скачать контракт
                  </a>
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
          PDF-документ. При необходимости используйте кнопку «Скачать для просмотра» ниже для
          просмотра контракта во внешней программе.
        </p>

        {/* Download link for a11y + edge-cases */}
        {blobUrl && !pdfError && (
          <div className="mt-1 flex justify-end">
            <a
              href={blobUrl}
              download="contract-preview.pdf"
              className="text-xs text-muted-foreground underline hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
            >
              Скачать для просмотра
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
          Не удалось загрузить предварительный просмотр контракта. Обратитесь к администратору.
        </div>
      )}

      {/* Info alert */}
      <p className="rounded-md border border-border bg-muted/10 px-4 py-3 text-sm text-muted-foreground">
        Данные в контракте: имя, email, реквизиты — задаются администратором. При ошибке обратитесь
        к ADMIN.
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
          Я ознакомился и подтверждаю условия MSA-контракта
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
          Юридическое ФИО не заполнено администратором. Подписание контракта невозможно. Обратитесь
          к ADMIN.
        </div>
      )}

      {/* Read-only signature block */}
      <div
        className="flex items-center gap-3 rounded-md border border-border bg-muted/20 px-4 py-3"
        role="group"
        aria-label="Подписант"
        data-testid="signature-block"
      >
        <Avatar className="h-8 w-8 shrink-0">
          <AvatarFallback className="text-xs">{getInitials(displayName)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium leading-none">{displayName || '—'}</p>
          <p className="mt-1 text-xs text-muted-foreground">Подпись — юридическое ФИО из профиля</p>
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
              className="w-full"
            >
              {signMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Подписание…
                </>
              ) : (
                'Подписать контракт'
              )}
            </Button>
          </span>
        </TooltipTrigger>
        {legalNameMissing && (
          <TooltipContent>
            Заполните юридическое ФИО в профиле (обратитесь к администратору)
          </TooltipContent>
        )}
      </Tooltip>
    </form>
  )
}
