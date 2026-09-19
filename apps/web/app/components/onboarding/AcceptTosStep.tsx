import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, Loader2, ScrollText } from 'lucide-react'
import { TOS_ACCEPT_IMPERSONATION_MESSAGE, type TosVersionDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'

/**
 * Fix-раунд 3 (task-680, SR-M-3). Тот же литерал, что отдаёт сервер в 403 на
 * `POST /tos/accept` (`TOS_ACCEPT_IMPERSONATION_MESSAGE`,
 * `packages/shared/src/schemas/tos.ts`) — точка на конце добавлена так же,
 * как `IMPERSONATION_EXPLANATION` в `SignContractStep.tsx` /
 * `NotificationSettingsTab.tsx`.
 */
const IMPERSONATION_EXPLANATION = `${TOS_ACCEPT_IMPERSONATION_MESSAGE}.`
const IMPERSONATION_EXPLANATION_ID = 'accept-tos-explain-impersonating'

interface AcceptTosStepProps {
  /** Called on success instead of navigating — wizard parent decides next step. */
  onSuccess: () => void
}

export function AcceptTosStep({ onSuccess }: AcceptTosStepProps) {
  const { user } = useAuth()
  const [accepted, setAccepted] = useState(false)
  const queryClient = useQueryClient()
  /** Бэклог 212 — под «войти как» принятие ToS должен сделать сам сотрудник. */
  const impersonating = Boolean(user?.impersonating)

  const { data: tos, isLoading: tosLoading } = useQuery<TosVersionDto>({
    queryKey: ['tos-current'],
    queryFn: async () => {
      const res = await api.get<TosVersionDto>('/tos/current')
      return res.data
    },
  })

  const acceptMutation = useMutation<void, Error, void>({
    mutationFn: async () => {
      await api.post('/tos/accept')
    },
    onSuccess: async () => {
      toast.success('Terms of Service принято')
      // Invalidate onboarding-status so gate in route.tsx sees updated state
      await queryClient.invalidateQueries({ queryKey: ['onboarding-status'] })
      onSuccess()
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Не удалось принять Terms of Service'
      toast.error(message)
    },
  })

  if (tosLoading) {
    return (
      <div className="flex flex-col items-center gap-4 py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Загрузка Terms of Service...</p>
      </div>
    )
  }

  if (!tos) {
    return (
      <div className="flex flex-col items-center gap-4 py-12">
        <ScrollText className="h-10 w-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Terms of Service не найден. Обратитесь к администратору.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6" data-testid="accept-tos-form">
      {/* Version badge */}
      <p className="text-xs text-muted-foreground">Terms of Service — версия {tos.version}</p>

      {/* Markdown preview */}
      <div className="rounded-lg border border-border bg-muted/30">
        <ScrollArea className="h-72 px-5 py-4">
          <article className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed">
            <ReactMarkdown>{tos.bodyMarkdown}</ReactMarkdown>
          </article>
        </ScrollArea>
      </div>

      {/* Checkbox */}
      <label
        className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 transition-colors hover:bg-muted/40"
        data-testid="accept-tos-checkbox-label"
      >
        <input
          type="checkbox"
          data-testid="accept-tos-checkbox"
          className="mt-0.5 h-4 w-4 accent-primary"
          checked={accepted}
          onChange={(e) => setAccepted(e.target.checked)}
        />
        <span className="text-sm leading-snug">Я принимаю Terms of Service</span>
      </label>

      {/* Бэклог 212 — под «войти как» принятие недоступно; тот же литерал,
          что отдаёт сервер в 403 на POST /tos/accept. */}
      {impersonating && (
        <div
          id={IMPERSONATION_EXPLANATION_ID}
          role="alert"
          aria-live="assertive"
          data-testid="accept-tos-impersonating-banner"
          className="rounded-md border border-amber-300/30 bg-amber-300/5 p-4 text-sm text-amber-300"
        >
          <AlertTriangle className="inline h-4 w-4 mr-2" />
          {IMPERSONATION_EXPLANATION}
        </div>
      )}

      {/* Submit */}
      <Button
        data-testid="accept-tos-button"
        disabled={!accepted || impersonating || acceptMutation.isPending}
        aria-disabled={!accepted || impersonating || acceptMutation.isPending}
        aria-describedby={impersonating ? IMPERSONATION_EXPLANATION_ID : undefined}
        onClick={() => acceptMutation.mutate()}
        className="w-full"
      >
        {acceptMutation.isPending ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Принятие...
          </>
        ) : (
          'Принять Terms of Service'
        )}
      </Button>
    </div>
  )
}
