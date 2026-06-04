import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'
import { Loader2, FileText, PenLine } from 'lucide-react'
import type {
  ContractTemplateDto,
  ContractRenderedPreviewDto,
  SignedContractDto,
} from '@crm/shared'
import { signContractSchema, contractRenderedPreviewSchema } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'

interface SignContractStepProps {
  onSuccess: () => void
}

export function SignContractStep({ onSuccess }: SignContractStepProps) {
  const { user } = useAuth()
  const [typedName, setTypedName] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const { data: template, isLoading: templateLoading } = useQuery<ContractTemplateDto>({
    queryKey: ['contract-template', user?.role],
    queryFn: async () => {
      const res = await api.get<ContractTemplateDto>(
        `/contracts/templates/current/${user?.role ?? ''}`,
      )
      return res.data
    },
    enabled: !!user && user.role !== 'ADMIN',
  })

  // Fetch substituted preview once template id is known.
  // Falls back to raw template body if preview endpoint fails (graceful degradation).
  const { data: preview } = useQuery<ContractRenderedPreviewDto>({
    queryKey: ['contract-preview', template?.id],
    queryFn: async () => {
      const res = await api.get<ContractRenderedPreviewDto>(
        `/contracts/templates/preview-rendered/${template!.id}`,
      )
      return contractRenderedPreviewSchema.parse(res.data)
    },
    enabled: !!template?.id,
    staleTime: 60_000,
  })

  // Rendered body: prefer substituted preview, fallback to raw template
  const previewBody = preview?.bodyMarkdown ?? template?.bodyMarkdown ?? ''

  const signMutation = useMutation<SignedContractDto, Error, z.infer<typeof signContractSchema>>({
    mutationFn: async (body) => {
      const res = await api.post<SignedContractDto>('/contracts/sign', body)
      return res.data
    },
    onSuccess: async (data) => {
      toast.success(`Контракт подписан. Номер: ${data.contractNumber}`)
      // Symmetry with AcceptTosStep — invalidate onboarding-status so gate sees fresh state.
      await queryClient.invalidateQueries({ queryKey: ['onboarding-status'] })
      onSuccess()
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Не удалось подписать контракт'
      // Defensive: ADMIN_DOES_NOT_SIGN_CONTRACTS shouldn't reach here via gate
      if (message.includes('ADMIN_DOES_NOT_SIGN_CONTRACTS')) {
        toast.info('Админ не подписывает контракт')
        return
      }
      toast.error(message)
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const result = signContractSchema.safeParse({ typedName })
    if (!result.success) {
      setNameError(result.error.issues[0]?.message ?? 'Ошибка валидации')
      return
    }
    setNameError(null)
    signMutation.mutate(result.data)
  }

  if (templateLoading) {
    return (
      <div className="flex flex-col items-center gap-4 py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Загрузка контракта...</p>
      </div>
    )
  }

  if (!template) {
    return (
      <div className="flex flex-col items-center gap-4 py-12">
        <FileText className="h-10 w-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Шаблон контракта для вашей роли не найден. Обратитесь к администратору.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6" data-testid="sign-contract-form">
      {/* Markdown preview */}
      <div className="rounded-lg border border-border bg-muted/30">
        <ScrollArea className="h-72 px-5 py-4">
          <article
            className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed"
            data-testid="contract-preview-body"
          >
            <ReactMarkdown>{previewBody}</ReactMarkdown>
          </article>
        </ScrollArea>
      </div>

      {/* Typed name */}
      <div className="flex flex-col gap-2">
        <Label htmlFor="typed-name">Введите ваше имя для подписи</Label>
        <div className="relative">
          <PenLine className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="typed-name"
            data-testid="typed-name-input"
            className="pl-9"
            placeholder="Ваше полное имя"
            value={typedName}
            onChange={(e) => {
              setTypedName(e.target.value)
              if (nameError) setNameError(null)
            }}
            autoComplete="name"
          />
        </div>
        {nameError && <p className="text-xs text-destructive">{nameError}</p>}
      </div>

      {/* Checkbox */}
      <label
        className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 transition-colors hover:bg-muted/40"
        data-testid="confirm-checkbox-label"
      >
        <input
          type="checkbox"
          data-testid="confirm-checkbox"
          className="mt-0.5 h-4 w-4 accent-primary"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        <span className="text-sm leading-snug">
          Я ознакомился и подтверждаю условия MSA-контракта
        </span>
      </label>

      {/* Submit */}
      <Button
        type="submit"
        data-testid="sign-button"
        disabled={!typedName.trim() || !confirmed || signMutation.isPending}
        className="w-full"
      >
        {signMutation.isPending ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Подписание...
          </>
        ) : (
          'Подписать контракт'
        )}
      </Button>
    </form>
  )
}
