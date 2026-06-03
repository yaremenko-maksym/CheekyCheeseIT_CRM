import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useQuery, useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'
import { Loader2, FileText, PenLine } from 'lucide-react'
import type { ContractTemplateDto, SignedContractDto } from '@crm/shared'
import { signContractSchema } from '@crm/shared'
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

  const signMutation = useMutation<SignedContractDto, Error, z.infer<typeof signContractSchema>>({
    mutationFn: async (body) => {
      const res = await api.post<SignedContractDto>('/contracts/sign', body)
      return res.data
    },
    onSuccess: (data) => {
      toast.success(`Контракт підписано. Номер: ${data.contractNumber}`)
      onSuccess()
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Не вдалося підписати контракт'
      // Defensive: ADMIN_DOES_NOT_SIGN_CONTRACTS shouldn't reach here via gate
      if (message.includes('ADMIN_DOES_NOT_SIGN_CONTRACTS')) {
        toast.info('Адмін не підписує контракт')
        return
      }
      toast.error(message)
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const result = signContractSchema.safeParse({ typedName })
    if (!result.success) {
      setNameError(result.error.issues[0]?.message ?? 'Помилка валідації')
      return
    }
    setNameError(null)
    signMutation.mutate(result.data)
  }

  if (templateLoading) {
    return (
      <div className="flex flex-col items-center gap-4 py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Завантаження контракту...</p>
      </div>
    )
  }

  if (!template) {
    return (
      <div className="flex flex-col items-center gap-4 py-12">
        <FileText className="h-10 w-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Шаблон контракту для вашої ролі не знайдено. Зверніться до адміністратора.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6" data-testid="sign-contract-form">
      {/* Markdown preview */}
      <div className="rounded-lg border border-border bg-muted/30">
        <ScrollArea className="h-72 px-5 py-4">
          <article className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed">
            <ReactMarkdown>{template.bodyMarkdown}</ReactMarkdown>
          </article>
        </ScrollArea>
      </div>

      {/* Typed name */}
      <div className="flex flex-col gap-2">
        <Label htmlFor="typed-name">Введіть ваше ім'я для підпису</Label>
        <div className="relative">
          <PenLine className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="typed-name"
            data-testid="typed-name-input"
            className="pl-9"
            placeholder="Ваше повне ім'я"
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
          Я ознайомився та підтверджую умови MSA-контракту
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
            Підписання...
          </>
        ) : (
          'Підписати контракт'
        )}
      </Button>
    </form>
  )
}
