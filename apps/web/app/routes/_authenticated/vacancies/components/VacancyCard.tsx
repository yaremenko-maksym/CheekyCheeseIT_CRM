/**
 * VacancyCard — task-crm-vacancies-ui §4.1 / §4.1.1. List-page card: status
 * badge, domain/seniority/employment tags, location + public slug, response
 * count, status-dependent action row.
 *
 * §4.1.1 (source of truth = backend, NOT the static macet — the macet draws
 * the delete icon active on every status; the REAL rule is
 * `vacancies.service.ts remove()`: only DRAFT with 0 applications):
 *   DRAFT     → Опубликовать · Редактировать · Удалить (disabled+Tooltip if applicationsCount > 0)
 *   PUBLISHED → Отклики · Редактировать · Закрыть (no delete button at all)
 *   CLOSED    → Восстановить · Редактировать · Удалить (always disabled+Tooltip)
 */
import { Link } from '@tanstack/react-router'
import { ArrowUp, Eye, MapPin, Pencil, RotateCcw, Trash2, Users, X } from 'lucide-react'
import type { Vacancy } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
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
import { useDeleteVacancy, useUpdateVacancy } from '@/hooks/use-vacancies'
import {
  DOMAIN_DOT_COLOR,
  DOMAIN_LABELS,
  EMPLOYMENT_TYPE_LABELS,
  SENIORITY_LABELS,
  VACANCY_STATUS_BADGE,
  VACANCY_STATUS_LABELS,
} from '../constants'

interface VacancyCardProps {
  vacancy: Vacancy
  onEdit: (vacancy: Vacancy) => void
}

/** §4.1: kept a plain `div` (not Card/CardHeader/CardContent) — their p-6
 * padding is too generous for a dense list card, same call as document-card.tsx. */
export function VacancyCard({ vacancy, onEdit }: VacancyCardProps) {
  const updateMutation = useUpdateVacancy()
  const deleteMutation = useDeleteVacancy()

  const canDelete = vacancy.status === 'DRAFT' && vacancy.applicationsCount === 0
  const deleteTooltip =
    vacancy.status === 'DRAFT'
      ? 'Нельзя удалить вакансию с откликами'
      : 'Удалить можно только вакансию в статусе DRAFT'

  const statusBadge = VACANCY_STATUS_BADGE[vacancy.status]
  const dotColor = DOMAIN_DOT_COLOR[vacancy.domain]

  return (
    <div
      className="flex flex-col rounded-xl border border-border bg-card p-4 shadow-sm transition hover:shadow-md"
      data-testid={`vacancy-card-${vacancy.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-pretty leading-snug">{vacancy.title}</h3>
        <Badge
          variant={statusBadge.variant}
          className={statusBadge.className ? `${statusBadge.className} shrink-0` : 'shrink-0'}
          data-testid={`vacancy-status-badge-${vacancy.id}`}
        >
          {VACANCY_STATUS_LABELS[vacancy.status]}
        </Badge>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary" className="gap-1.5">
          {dotColor && (
            <span
              aria-hidden
              className="h-[6px] w-[6px] rounded-full"
              style={{ backgroundColor: dotColor }}
            />
          )}
          {DOMAIN_LABELS[vacancy.domain]}
        </Badge>
        <Badge variant="secondary">{SENIORITY_LABELS[vacancy.seniority]}</Badge>
        <Badge variant="secondary">{EMPLOYMENT_TYPE_LABELS[vacancy.employmentType]}</Badge>
      </div>

      <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <MapPin className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{vacancy.location}</span>
        <span aria-hidden>·</span>
        <span className="truncate font-mono">/careers/{vacancy.slug}</span>
      </div>

      <Separator className="my-3" />

      <div className="flex items-center justify-between gap-2">
        {/* §4.1 draws a "N новых" badge here too — but `Vacancy` (mapVacancy(),
           vacancies.service.ts) does not carry a per-vacancy new-applications
           count, only the total `applicationsCount`. Computing it accurately
           on the list would mean an N+1 applications fetch per card; the
           detail page's «Отклики» tab (fetches the full list once) shows the
           real per-status breakdown instead — backend contract wins over the
           static macet (spec §4.1.1's own precedent). */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Users className="h-3.5 w-3.5" />
          <span>{vacancy.applicationsCount} откликов</span>
        </div>

        <div className="flex items-center gap-1.5">
          {vacancy.status === 'DRAFT' && (
            <Button
              size="sm"
              onClick={() =>
                updateMutation.mutate({ id: vacancy.id, dto: { status: 'PUBLISHED' } })
              }
              disabled={updateMutation.isPending}
              data-testid={`vacancy-publish-${vacancy.id}`}
            >
              <ArrowUp className="mr-1 h-3.5 w-3.5" />
              Опубликовать
            </Button>
          )}

          {vacancy.status === 'PUBLISHED' && (
            <Button size="sm" asChild data-testid={`vacancy-applications-${vacancy.id}`}>
              <Link
                to="/vacancies/$vacancyId"
                params={{ vacancyId: vacancy.id }}
                search={{ tab: 'applications' }}
              >
                <Eye className="mr-1 h-3.5 w-3.5" />
                Отклики
              </Link>
            </Button>
          )}

          {vacancy.status === 'CLOSED' && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                updateMutation.mutate({ id: vacancy.id, dto: { status: 'PUBLISHED' } })
              }
              disabled={updateMutation.isPending}
              data-testid={`vacancy-reopen-${vacancy.id}`}
            >
              <RotateCcw className="mr-1 h-3.5 w-3.5" />
              Восстановить
            </Button>
          )}

          <Button
            size="sm"
            variant="outline"
            onClick={() => onEdit(vacancy)}
            data-testid={`vacancy-edit-${vacancy.id}`}
          >
            <Pencil className="mr-1 h-3.5 w-3.5" />
            Редактировать
          </Button>

          {vacancy.status === 'PUBLISHED' && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => updateMutation.mutate({ id: vacancy.id, dto: { status: 'CLOSED' } })}
              disabled={updateMutation.isPending}
              data-testid={`vacancy-close-${vacancy.id}`}
              aria-label="Закрыть вакансию"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}

          {vacancy.status !== 'PUBLISHED' && (
            <DeleteVacancyButton
              vacancy={vacancy}
              canDelete={canDelete}
              tooltip={deleteTooltip}
              onDelete={() => deleteMutation.mutate(vacancy.id)}
              isPending={deleteMutation.isPending}
            />
          )}
        </div>
      </div>
    </div>
  )
}

export interface DeleteVacancyButtonProps {
  vacancy: Vacancy
  canDelete: boolean
  tooltip: string
  onDelete: () => void
  isPending: boolean
  /**
   * 'icon' (default) — ghost icon-only button for the dense list card.
   * 'full' — full-width labeled destructive button, for the detail page's
   * «Опасная зона» card (§4.3). Both share the exact same confirm dialog —
   * exported so $vacancyId.tsx doesn't re-implement the delete-gate logic
   * (golden rule #8 — no duplicated logic).
   */
  variant?: 'icon' | 'full'
}

export function DeleteVacancyButton({
  vacancy,
  canDelete,
  tooltip,
  onDelete,
  isPending,
  variant = 'icon',
}: DeleteVacancyButtonProps) {
  const trigger =
    variant === 'full' ? (
      <Button
        variant="destructive"
        className="w-full"
        disabled={!canDelete}
        data-testid={
          canDelete ? `vacancy-delete-${vacancy.id}` : `vacancy-delete-disabled-${vacancy.id}`
        }
      >
        <Trash2 className="mr-1.5 h-3.5 w-3.5" />
        Удалить вакансию
      </Button>
    ) : (
      <Button
        size="sm"
        variant="ghost"
        disabled={!canDelete}
        className="text-muted-foreground hover:text-destructive"
        aria-label={canDelete ? 'Удалить вакансию' : 'Удалить вакансию (недоступно)'}
        data-testid={
          canDelete ? `vacancy-delete-${vacancy.id}` : `vacancy-delete-disabled-${vacancy.id}`
        }
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    )

  if (!canDelete) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={variant === 'full' ? 'block' : undefined}>{trigger}</span>
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Удалить вакансию?</AlertDialogTitle>
          <AlertDialogDescription>
            Вакансия «{vacancy.title}» будет удалена навсегда. Это действие необратимо.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={onDelete}
            disabled={isPending}
            data-testid={`vacancy-delete-confirm-${vacancy.id}`}
          >
            Удалить
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
