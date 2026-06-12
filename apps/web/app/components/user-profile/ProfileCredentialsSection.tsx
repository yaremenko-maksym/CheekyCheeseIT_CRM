import { useState } from 'react'
import { Check, Copy, Eye, EyeOff, ExternalLink, KeyRound, Loader2 } from 'lucide-react'
import type { ProjectCredential } from '@crm/shared'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { useRevealUserCredential, useUserCredentials } from '@/hooks/use-credentials'
import { getAxiosStatus } from '@/lib/axios-utils'

/**
 * task-junior-ut-round2 §6 — project credentials of a JUNIOR, shown in that
 * junior's profile (OverviewTab) to ADMIN / HR only. Backend RBAC decides
 * access; a 403 makes the hook return null and the section hides itself.
 *
 * SECURITY: the list never carries plaintext — reveal is a separate manual call
 * (throttled + no-store on the server). Plaintext lives ONLY in local state,
 * never in the query cache.
 */
interface ProfileCredentialsSectionProps {
  /** UUID of the JUNIOR whose project credentials are shown. */
  userId: string
}

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//i, '')
}

export function ProfileCredentialsSection({ userId }: ProfileCredentialsSectionProps) {
  const { data: credentials, isLoading, isError } = useUserCredentials(userId)

  // 403 → hook returns null → hide entirely. isError (non-403) → hide too.
  if (!isLoading && (credentials === null || isError)) return null

  return (
    <Card data-testid="profile-credentials-section" className="border-border/40">
      <CardHeader className="pb-3">
        <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <KeyRound className="h-3.5 w-3.5" />
          Пароли проекта
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full rounded-md" />
            <Skeleton className="h-12 w-full rounded-md" />
          </div>
        ) : !credentials || credentials.length === 0 ? (
          <p className="text-sm text-muted-foreground/60 italic">Нет сохранённых паролей</p>
        ) : (
          <ul className="space-y-1" data-testid="profile-credentials-list">
            {credentials.map((cred, i) => (
              <li key={cred.id}>
                {i > 0 && <Separator className="my-1" />}
                <ProfileCredentialRow credential={cred} userId={userId} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function ProfileCredentialRow({
  credential,
  userId,
}: {
  credential: ProjectCredential
  userId: string
}) {
  const reveal = useRevealUserCredential(userId)
  const [plaintext, setPlaintext] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const revealed = plaintext !== null

  const handleToggleReveal = async () => {
    if (revealed) {
      setPlaintext(null)
      return
    }
    setError(null)
    try {
      const password = await reveal.mutateAsync(credential.id)
      setPlaintext(password)
    } catch (err: unknown) {
      const status = getAxiosStatus(err)
      if (status === 403) setError('Нет доступа к этому паролю')
      else if (status === 429) setError('Слишком много запросов. Попробуйте через минуту.')
      else setError('Не удалось получить пароль. Попробуйте ещё раз.')
    }
  }

  const handleCopy = async () => {
    if (plaintext === null) return
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(plaintext)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Не удалось скопировать. Скопируйте вручную.')
    }
  }

  return (
    <div className="py-1.5" data-testid={`profile-credentials-item-${credential.id}`}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate" title={credential.label}>
            {credential.label}
          </p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {credential.login && (
              <span className="truncate max-w-[160px] sm:max-w-[240px]" title={credential.login}>
                {credential.login}
              </span>
            )}
            {credential.login && credential.url && <span aria-hidden>·</span>}
            {credential.url && (
              <a
                href={credential.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 truncate max-w-[120px] sm:max-w-[180px] hover:text-foreground transition-colors"
              >
                <span className="truncate">{stripProtocol(credential.url)}</span>
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            )}
          </div>
          {revealed ? (
            <p
              className="text-sm font-mono mt-0.5 break-all"
              data-testid={`profile-credentials-plaintext-${credential.id}`}
            >
              {plaintext}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground/50 tracking-widest font-mono mt-0.5">
              ••••••••
            </p>
          )}
          {error && <p className="text-xs text-destructive mt-0.5">{error}</p>}
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            aria-label={revealed ? 'Скрыть пароль' : 'Показать пароль'}
            aria-pressed={revealed}
            disabled={reveal.isPending}
            data-testid={`profile-credentials-reveal-btn-${credential.id}`}
            onClick={() => void handleToggleReveal()}
          >
            {reveal.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : revealed ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </Button>
          {revealed && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              aria-label={copied ? 'Скопировано' : 'Копировать пароль'}
              data-testid={`profile-credentials-copy-btn-${credential.id}`}
              onClick={() => void handleCopy()}
            >
              {copied ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
