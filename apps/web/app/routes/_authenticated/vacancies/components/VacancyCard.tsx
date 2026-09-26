/**
 * VacancyCard — task-crm-vacancies-ui §4.1 / §4.1.1 (delete gate updated by
 * task-vacancy-delete-closed). List-page card: status badge, domain/
 * seniority/employment tags, location + public slug, response count,
 * status-dependent action row.
 *
 * §4.1.1 (source of truth = backend, NOT the static macet — the macet draws
 * the delete icon active on every status; the REAL rule is
 * `getVacancyDeleteGate()` / `vacancies.service.ts remove()`: DRAFT or CLOSED
 * with 0 applications):
 *   DRAFT     → Publish · Edit · Delete (disabled+Tooltip if applicationsCount > 0)
 *   PUBLISHED → Applications · Edit · Close (no delete button at all)
 *   CLOSED    → Reopen · Edit · Delete (disabled+Tooltip only if applicationsCount > 0)
 */
import type { ReactElement } from 'react'
import { Link } from '@tanstack/react-router'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
  ArrowUp,
  Eye,
  MapPin,
  MoreVertical,
  Pencil,
  RotateCcw,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import type { Vacancy } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { trackFeatureClick } from '@/lib/telemetry'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
  domainDotColor,
  DOMAIN_LABELS,
  EMPLOYMENT_TYPE_LABEL_MESSAGES,
  getVacancyDeleteGate,
  getVacancyPublishGate,
  SENIORITY_LABELS,
  VACANCY_STATUS_BADGE,
  VACANCY_STATUS_LABEL_MESSAGES,
} from '../constants'

/**
 * task-vacancy-salary-range — wraps a «Publish»/«Reopen» button
 * with `getVacancyPublishGate()`'s disabled+Tooltip treatment (render-prop:
 * `children(disabled)` builds the actual `<Button>` with its own
 * size/variant/icon/testid, only the disabled flag + tooltip wrapping are
 * centralized here — same "disable + Tooltip when blocked" convention as
 * `DeleteVacancyButton` below, but as a thin wrapper since the 6 call sites
 * (mobile/desktop × list card × detail page) differ too much in JSX to
 * usefully unify into one concrete `<Button>`).
 */
export function VacancyPublishGate({
  vacancy,
  children,
}: {
  vacancy: Pick<Vacancy, 'salaryMin' | 'salaryMax' | 'salaryCurrency' | 'salaryPeriod'>
  children: (disabled: boolean) => ReactElement
}) {
  const { canPublish, tooltip } = getVacancyPublishGate(vacancy)
  const button = children(!canPublish)
  if (canPublish) return button
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="contents">{button}</span>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

interface VacancyCardProps {
  vacancy: Vacancy
  onEdit: (vacancy: Vacancy) => void
}

/** §4.1: kept a plain `div` (not Card/CardHeader/CardContent) — their p-6
 * padding is too generous for a dense list card, same call as document-card.tsx. */
export function VacancyCard({ vacancy, onEdit }: VacancyCardProps) {
  const { t, i18n } = useLingui()
  const updateMutation = useUpdateVacancy()
  const deleteMutation = useDeleteVacancy()

  const { canDelete, tooltip: deleteTooltip } = getVacancyDeleteGate(vacancy)

  const statusBadge = VACANCY_STATUS_BADGE[vacancy.status]
  const dotColor = domainDotColor(vacancy.domain)

  return (
    <div
      className="flex flex-col rounded-xl border border-border bg-card p-4 shadow-sm transition hover:shadow-md"
      data-testid={`vacancy-card-${vacancy.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        {/* Title links to the detail page for ALL statuses — PUBLISHED already
           has an explicit «Applications» button that lands there, but
           DRAFT/CLOSED have no other path to the detail page's «Details» tab
           (Danger Zone, stats, inline edit) besides typing the URL directly
           (confirmed live — there was no way to reach it from the list
           before this). */}
        <h3 className="text-sm font-semibold text-pretty leading-snug">
          <Link
            to="/vacancies/$vacancyId"
            params={{ vacancyId: vacancy.id }}
            className="hover:underline focus-visible:underline focus-visible:outline-none"
            data-testid={`vacancy-title-link-${vacancy.id}`}
          >
            {vacancy.title}
          </Link>
        </h3>
        <Badge
          variant={statusBadge.variant}
          className={statusBadge.className ? `${statusBadge.className} shrink-0` : 'shrink-0'}
          data-testid={`vacancy-status-badge-${vacancy.id}`}
        >
          {i18n._(VACANCY_STATUS_LABEL_MESSAGES[vacancy.status])}
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
        <Badge variant="secondary">
          {i18n._(EMPLOYMENT_TYPE_LABEL_MESSAGES[vacancy.employmentType])}
        </Badge>
      </div>

      <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <MapPin className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{vacancy.location}</span>
        <span aria-hidden>·</span>
        <span className="truncate font-mono">/careers/{vacancy.slug}</span>
      </div>

      <Separator className="my-3" />

      {/* §4.1 draws a "N new" badge here too — but `Vacancy` (mapVacancy(),
         vacancies.service.ts) does not carry a per-vacancy new-applications
         count, only the total `applicationsCount`. Computing it accurately
         on the list would mean an N+1 applications fetch per card; the
         detail page's «Applications» tab (fetches the full list once) shows
         the real per-status breakdown instead — backend contract wins over
         the static macet (spec §4.1.1's own precedent). */}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground sm:hidden">
        <Users className="h-3.5 w-3.5" />
        <span>
          <Plural
            value={vacancy.applicationsCount}
            one="# відгук"
            few="# відгуки"
            many="# відгуків"
            other="# відгука"
          />
        </span>
      </div>

      {/* §4.1.1 Mobile (<640): the applications count on its own row, below —
         the main button (flex-1, h-11 touch target) + an icon-only «Edit» +
         a kebab menu (MoreVertical) instead of the whole desktop row — at
         320px 3+ full-size buttons in one row physically don't fit
         (confirmed by a live Playwright pass at this width). */}
      <div className="mt-2 flex items-center gap-1.5 sm:hidden">
        {vacancy.status === 'DRAFT' && (
          <VacancyPublishGate vacancy={vacancy}>
            {(disabled) => (
              <Button
                className="h-11 flex-1"
                onClick={() =>
                  updateMutation.mutate({ id: vacancy.id, dto: { status: 'PUBLISHED' } })
                }
                disabled={updateMutation.isPending || disabled}
                data-testid={`vacancy-publish-mobile-${vacancy.id}`}
                data-track="vacancy-publish"
              >
                <ArrowUp className="mr-1.5 h-4 w-4" />
                <Trans>Опублікувати</Trans>
              </Button>
            )}
          </VacancyPublishGate>
        )}
        {vacancy.status === 'PUBLISHED' && (
          <Button
            className="h-11 flex-1"
            asChild
            data-testid={`vacancy-applications-mobile-${vacancy.id}`}
          >
            <Link
              to="/vacancies/$vacancyId"
              params={{ vacancyId: vacancy.id }}
              search={{ tab: 'applications' }}
            >
              <Eye className="mr-1.5 h-4 w-4" />
              <Trans>Відгуки</Trans>
            </Link>
          </Button>
        )}
        {vacancy.status === 'CLOSED' && (
          <VacancyPublishGate vacancy={vacancy}>
            {(disabled) => (
              <Button
                variant="outline"
                className="h-11 flex-1"
                onClick={() =>
                  updateMutation.mutate({ id: vacancy.id, dto: { status: 'PUBLISHED' } })
                }
                disabled={updateMutation.isPending || disabled}
                data-testid={`vacancy-reopen-mobile-${vacancy.id}`}
              >
                <RotateCcw className="mr-1.5 h-4 w-4" />
                <Trans>Відновити</Trans>
              </Button>
            )}
          </VacancyPublishGate>
        )}

        <Button
          variant="outline"
          size="icon"
          className="h-11 w-11 shrink-0"
          onClick={() => onEdit(vacancy)}
          aria-label={t`Редагувати вакансію`}
          data-testid={`vacancy-edit-mobile-${vacancy.id}`}
        >
          <Pencil className="h-4 w-4" />
        </Button>

        {/* Kebab only rendered when it holds at least one action — an empty
           kebab (e.g. CLOSED, where delete is always disabled) is worse UX
           than no button at all (§4.1.1 "on mobile it's more compact to hide
           an unavailable action than to show a disabled menu item"). */}
        {(vacancy.status === 'PUBLISHED' || canDelete) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="h-11 w-11 shrink-0"
                aria-label={t`Ще дії`}
                data-testid={`vacancy-more-mobile-${vacancy.id}`}
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {vacancy.status === 'PUBLISHED' && (
                <DropdownMenuItem
                  onClick={() =>
                    updateMutation.mutate({ id: vacancy.id, dto: { status: 'CLOSED' } })
                  }
                  data-testid={`vacancy-close-mobile-${vacancy.id}`}
                >
                  <Trans>Закрити вакансію</Trans>
                </DropdownMenuItem>
              )}
              {vacancy.status !== 'PUBLISHED' && canDelete && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={(e) => e.preventDefault()}
                      data-testid={`vacancy-delete-mobile-${vacancy.id}`}
                    >
                      <Trans>Видалити</Trans>
                    </DropdownMenuItem>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        <Trans>Видалити вакансію?</Trans>
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        <Trans>
                          Вакансія «{vacancy.title}» буде видалена назавжди. Цю дію не можна
                          скасувати.
                        </Trans>
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>
                        <Trans>Скасувати</Trans>
                      </AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        onClick={() => deleteMutation.mutate(vacancy.id)}
                        disabled={deleteMutation.isPending}
                        data-testid={`vacancy-delete-confirm-mobile-${vacancy.id}`}
                      >
                        <Trans>Видалити</Trans>
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* ≥640px (spec §4.1): full row, applications count + action buttons share one line. */}
      <div className="hidden items-center justify-between gap-2 sm:flex">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Users className="h-3.5 w-3.5" />
          <span>
            <Plural
              value={vacancy.applicationsCount}
              one="# відгук"
              few="# відгуки"
              many="# відгуків"
              other="# відгука"
            />
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {vacancy.status === 'DRAFT' && (
            <VacancyPublishGate vacancy={vacancy}>
              {(disabled) => (
                <Button
                  size="sm"
                  onClick={() =>
                    updateMutation.mutate({ id: vacancy.id, dto: { status: 'PUBLISHED' } })
                  }
                  disabled={updateMutation.isPending || disabled}
                  data-testid={`vacancy-publish-${vacancy.id}`}
                  data-track="vacancy-publish"
                >
                  <ArrowUp className="mr-1 h-3.5 w-3.5" />
                  <Trans>Опублікувати</Trans>
                </Button>
              )}
            </VacancyPublishGate>
          )}

          {vacancy.status === 'PUBLISHED' && (
            <Button size="sm" asChild data-testid={`vacancy-applications-${vacancy.id}`}>
              <Link
                to="/vacancies/$vacancyId"
                params={{ vacancyId: vacancy.id }}
                search={{ tab: 'applications' }}
              >
                <Eye className="mr-1 h-3.5 w-3.5" />
                <Trans>Відгуки</Trans>
              </Link>
            </Button>
          )}

          {vacancy.status === 'CLOSED' && (
            <VacancyPublishGate vacancy={vacancy}>
              {(disabled) => (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    updateMutation.mutate({ id: vacancy.id, dto: { status: 'PUBLISHED' } })
                  }
                  disabled={updateMutation.isPending || disabled}
                  data-testid={`vacancy-reopen-${vacancy.id}`}
                >
                  <RotateCcw className="mr-1 h-3.5 w-3.5" />
                  <Trans>Відновити</Trans>
                </Button>
              )}
            </VacancyPublishGate>
          )}

          <Button
            size="sm"
            variant="outline"
            onClick={() => onEdit(vacancy)}
            data-testid={`vacancy-edit-${vacancy.id}`}
          >
            <Pencil className="mr-1 h-3.5 w-3.5" />
            <Trans>Редагувати</Trans>
          </Button>

          {vacancy.status === 'PUBLISHED' && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => updateMutation.mutate({ id: vacancy.id, dto: { status: 'CLOSED' } })}
              disabled={updateMutation.isPending}
              data-testid={`vacancy-close-${vacancy.id}`}
              aria-label={t`Закрити вакансію`}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}

          {vacancy.status !== 'PUBLISHED' && (
            <DeleteVacancyButton
              vacancy={vacancy}
              canDelete={canDelete}
              tooltip={deleteTooltip}
              onDelete={() => {
                trackFeatureClick('vacancy-delete')
                deleteMutation.mutate(vacancy.id)
              }}
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
   * «Danger Zone» card (§4.3). Both share the exact same confirm dialog —
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
  const { t } = useLingui()
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
        <Trans>Видалити вакансію</Trans>
      </Button>
    ) : (
      <Button
        size="sm"
        variant="ghost"
        disabled={!canDelete}
        className="text-muted-foreground hover:text-destructive"
        aria-label={canDelete ? t`Видалити вакансію` : t`Видалити вакансію (недоступно)`}
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
          <AlertDialogTitle>
            <Trans>Видалити вакансію?</Trans>
          </AlertDialogTitle>
          <AlertDialogDescription>
            <Trans>
              Вакансія «{vacancy.title}» буде видалена назавжди. Цю дію не можна скасувати.
            </Trans>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            <Trans>Скасувати</Trans>
          </AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={onDelete}
            disabled={isPending}
            data-testid={`vacancy-delete-confirm-${vacancy.id}`}
          >
            <Trans>Видалити</Trans>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
