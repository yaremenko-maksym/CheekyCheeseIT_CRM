/**
 * CandidateCard — task-crm-vacancies-ui §5. Vacancy application card: avatar
 * initials + name + «Новый»-badge + date, email + contact chips
 * (telegram/github/linkedin — only when present), collapsible cover letter,
 * footer (download resume · delete · status SegmentedToggle).
 *
 * `isNew`/ring-highlight/badge are ALL derived from ONE field —
 * `status === 'NEW'` (spec §5 — the macet's separate `isNew` prop is a
 * generation artifact, the real schema has no such field).
 */
import { useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { ru } from 'date-fns/locale'
// lucide-react@1.x dropped brand/logo icons (Github/Linkedin) — ExternalLink
// is the generic stand-in; the visible "GitHub"/"LinkedIn" text label already
// distinguishes the two chips.
import { Download, ExternalLink, Send, Trash2 } from 'lucide-react'
import type { VacancyApplication, VacancyApplicationStatus } from '@crm/shared'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { SegmentedToggle, type SegmentedToggleOption } from '@/components/ui/segmented-toggle'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import { getInitials } from '@/components/users/constants'
import {
  useApplicationResumeUrl,
  useDeleteVacancyApplication,
  useUpdateVacancyApplication,
} from '@/hooks/use-vacancies'
import { APPLICATION_STATUS_LABELS, safeExternalHref } from '../constants'

const STATUS_OPTIONS: ReadonlyArray<SegmentedToggleOption<VacancyApplicationStatus>> = [
  { value: 'NEW', label: APPLICATION_STATUS_LABELS.NEW },
  { value: 'VIEWED', label: APPLICATION_STATUS_LABELS.VIEWED },
  { value: 'REJECTED', label: APPLICATION_STATUS_LABELS.REJECTED, activeVariant: 'destructive' },
]

interface CandidateCardProps {
  vacancyId: string
  application: VacancyApplication
}

export function CandidateCard({ vacancyId, application }: CandidateCardProps) {
  const [coverLetterOpen, setCoverLetterOpen] = useState(false)
  const resumeUrlQuery = useApplicationResumeUrl(vacancyId, application.id, { enabled: false })
  const updateStatus = useUpdateVacancyApplication(vacancyId)
  const deleteApplication = useDeleteVacancyApplication(vacancyId)

  const isNew = application.status === 'NEW'
  const relativeDate = (() => {
    try {
      return formatDistanceToNow(new Date(application.createdAt), { addSuffix: true, locale: ru })
    } catch {
      return application.createdAt
    }
  })()

  async function handleDownload() {
    const result = await resumeUrlQuery.refetch()
    const url = result.data?.url
    if (!url) return
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div
      className={cn(
        'flex flex-col rounded-xl border border-border bg-card p-4 shadow-sm',
        isNew && 'ring-1 ring-primary/45',
      )}
      data-testid={`candidate-card-${application.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <Avatar className="h-9 w-9 shrink-0">
            <AvatarFallback>{getInitials(application.fullName)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold truncate">{application.fullName}</span>
              {isNew && (
                <Badge data-testid={`candidate-new-badge-${application.id}`}>
                  {APPLICATION_STATUS_LABELS.NEW}
                </Badge>
              )}
            </div>
            <a
              href={`mailto:${application.email}`}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              {application.email}
            </a>
          </div>
        </div>
        <span className="text-xs text-muted-foreground shrink-0" title={application.createdAt}>
          {relativeDate}
        </span>
      </div>

      {(application.telegram || application.githubUrl || application.linkedinUrl) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {application.telegram && (
            <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
              <Send className="h-3 w-3" />
              {application.telegram}
            </span>
          )}
          {application.githubUrl && (
            <ExternalContactChip url={application.githubUrl} label="GitHub" />
          )}
          {application.linkedinUrl && (
            <ExternalContactChip url={application.linkedinUrl} label="LinkedIn" />
          )}
        </div>
      )}

      {application.coverLetter && (
        <details
          className="mt-3"
          open={coverLetterOpen}
          onToggle={(e) => setCoverLetterOpen(e.currentTarget.open)}
        >
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
            Сопроводительное письмо
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-sm text-foreground/90">
            {application.coverLetter}
          </p>
        </details>
      )}

      <Separator className="my-3" />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {application.resumeSizeBytes !== null ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleDownload()}
              disabled={resumeUrlQuery.isFetching}
              data-testid={`candidate-download-${application.id}`}
            >
              <Download className="mr-1 h-3.5 w-3.5" />
              Скачать резюме
            </Button>
          ) : (
            // task-file-storage-hardening §2: resumeSizeBytes is null once the
            // 180-day file-only retention purge has cleared the file — the
            // application row (this card) survives, but there is nothing left
            // to download.
            <span
              className="text-xs text-muted-foreground"
              data-testid={`candidate-resume-purged-${application.id}`}
            >
              Резюме удалено (истёк срок хранения)
            </span>
          )}

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                aria-label="Удалить отклик"
                data-testid={`candidate-delete-${application.id}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Удалить отклик?</AlertDialogTitle>
                <AlertDialogDescription>
                  Отклик кандидата {application.fullName} будет удалён. Загруженный файл резюме
                  также будет удалён с сервера. Это действие необратимо.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Отмена</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => deleteApplication.mutate(application.id)}
                  disabled={deleteApplication.isPending}
                  data-testid={`candidate-delete-confirm-${application.id}`}
                >
                  Удалить
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        <SegmentedToggle<VacancyApplicationStatus>
          value={application.status}
          onChange={(status) => updateStatus.mutate({ appId: application.id, status })}
          options={STATUS_OPTIONS}
          ariaLabel={`Статус отклика кандидата ${application.fullName}`}
          variant="pill"
          size="sm"
          disabled={updateStatus.isPending}
          testId={`candidate-status-${application.id}`}
        />
      </div>
    </div>
  )
}

/**
 * security-MED (PR #396 review): renders the URL as a real link only when
 * `safeExternalHref` accepts it (http/https) — otherwise falls back to a
 * plain, non-clickable chip with the same label so a `javascript:` (or any
 * other non-http(s)) value from `vacancyApplication.{githubUrl,linkedinUrl}`
 * never reaches a rendered `href`.
 */
function ExternalContactChip({ url, label }: { url: string; label: string }) {
  const href = safeExternalHref(url)
  const className =
    'inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground'

  if (!href) {
    return (
      <span className={className} title={url}>
        <ExternalLink className="h-3 w-3" />
        {label}
      </span>
    )
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(className, 'hover:text-foreground')}
    >
      <ExternalLink className="h-3 w-3" />
      {label}
    </a>
  )
}
