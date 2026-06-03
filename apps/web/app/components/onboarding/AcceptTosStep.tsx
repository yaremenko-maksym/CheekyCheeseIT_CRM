import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, ScrollText } from 'lucide-react'
import type { TosVersionDto } from '@crm/shared'
import { api } from '@/lib/axios'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'

interface AcceptTosStepProps {
  /** Called on success instead of navigating — wizard parent decides next step. */
  onSuccess: () => void
}

export function AcceptTosStep({ onSuccess }: AcceptTosStepProps) {
  const [accepted, setAccepted] = useState(false)
  const queryClient = useQueryClient()

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
      toast.success('Terms of Service прийнято')
      // Invalidate onboarding-status so gate in route.tsx sees updated state
      await queryClient.invalidateQueries({ queryKey: ['onboarding-status'] })
      onSuccess()
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Не вдалося прийняти Terms of Service'
      toast.error(message)
    },
  })

  if (tosLoading) {
    return (
      <div className="flex flex-col items-center gap-4 py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Завантаження Terms of Service...</p>
      </div>
    )
  }

  if (!tos) {
    return (
      <div className="flex flex-col items-center gap-4 py-12">
        <ScrollText className="h-10 w-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Terms of Service не знайдено. Зверніться до адміністратора.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6" data-testid="accept-tos-form">
      {/* Version badge */}
      <p className="text-xs text-muted-foreground">Terms of Service — версія {tos.version}</p>

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
        <span className="text-sm leading-snug">Я приймаю Terms of Service</span>
      </label>

      {/* Submit */}
      <Button
        data-testid="accept-tos-button"
        disabled={!accepted || acceptMutation.isPending}
        onClick={() => acceptMutation.mutate()}
        className="w-full"
      >
        {acceptMutation.isPending ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Прийняття...
          </>
        ) : (
          'Прийняти Terms of Service'
        )}
      </Button>
    </div>
  )
}
