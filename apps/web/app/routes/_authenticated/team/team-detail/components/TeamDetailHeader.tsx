import { Link } from '@tanstack/react-router'
import { motion } from 'framer-motion'
import { Archive, ArrowLeft, Calendar, Pencil, RefreshCw, Send, UserPlus } from 'lucide-react'
import type { Role, TeamDto } from '@crm/shared'
import { formatDate } from '@crm/shared'
import { Trans, useLingui } from '@lingui/react/macro'
import { useLocale } from '@/lib/i18n'
import { ProfileNameLink } from '@/components/users/ProfileNameLink'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { tgUrl } from '@/lib/tg-url'
import { item } from '../constants'
import { TeamUnarchiveHeaderButton } from './TeamUnarchiveHeaderButton'

type TeamMember = TeamDto['members'][number]

/**
 * Presentational team-detail page header. SECURITY-SENSITIVE: it renders the
 * buttons that trigger every sensitive team action (edit / add member /
 * archive / unarchive / rotate senior) behind RBAC gates. The gate flags
 * (`canManage`, `canRotateSenior`, `isDropTeam`) are COMPUTED in the page
 * root and passed in; the header never computes access itself and owns no
 * mutation, form or query. Each action button only invokes a callback that
 * the root provides (`onEdit` seeds the root's edit form before opening the
 * dialog).
 */
export function TeamDetailHeader({
  team,
  viewerRole,
  isDropTeam,
  dropOwner,
  activeSenior,
  canManage,
  canRotateSenior,
  onRotateSenior,
  onAddMember,
  onEdit,
  onArchive,
}: {
  team: TeamDto
  viewerRole: Role | undefined
  isDropTeam: boolean
  dropOwner: TeamMember | null
  activeSenior: TeamMember | null
  canManage: boolean | undefined
  canRotateSenior: boolean | undefined
  onRotateSenior: () => void
  onAddMember: () => void
  onEdit: () => void
  onArchive: () => void
}) {
  const { t } = useLingui()
  const locale = useLocale()

  return (
    <motion.div variants={item} className="flex items-start justify-between gap-4">
      <div className="flex items-center gap-3">
        {/* Back button hidden for SENIOR, JUNIOR, and DROP.
              SENIOR/JUNIOR: they don't see the team list (no "Team" nav item).
              DROP: redirected to their one team — nowhere to go back to, the
              back button would loop. */}
        {viewerRole !== 'SENIOR' && viewerRole !== 'JUNIOR' && viewerRole !== 'DROP' && (
          <Button
            asChild
            variant="outline"
            size="icon"
            className="shrink-0"
            data-testid="back-button"
          >
            <Link to="/team">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
        )}
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold tracking-tight">{team.name}</h1>
            {/* Drop role - phase 1 (AC5): DROP badge + "drop's team"
                  caption surface the team type. Senior-teams render no
                  extra badge, header rendering 1:1 as before. */}
            {isDropTeam && (
              <Badge variant="drop" data-testid="team-drop-badge">
                <Trans>Команда дропа</Trans>
              </Badge>
            )}
            {team.archivedAt ? (
              <Badge
                variant="outline"
                className="border-amber-500/30 bg-amber-500/10 text-amber-500"
                data-testid="team-archived-badge"
              >
                <Trans>В архіві</Trans>
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
              >
                <Trans>Активна</Trans>
              </Badge>
            )}
          </div>
          {/* AC5: drop owner link under the title — quick navigation to
                the drop's profile, mirrors the "senior" bookmark on senior
                teams. */}
          {isDropTeam && dropOwner && (
            <p className="text-xs text-muted-foreground mt-0.5">
              <Trans>Дроп:</Trans>{' '}
              <ProfileNameLink
                userId={dropOwner.userId}
                viewerRole={viewerRole ?? 'JUNIOR'}
                className="text-primary hover:underline font-medium"
              >
                {dropOwner.displayName}
              </ProfileNameLink>
              {activeSenior ? (
                <>
                  <Trans> · Сеньйор: </Trans>
                  <ProfileNameLink
                    userId={activeSenior.userId}
                    viewerRole={viewerRole ?? 'JUNIOR'}
                    className="text-primary hover:underline font-medium"
                  >
                    {activeSenior.displayName}
                  </ProfileNameLink>
                </>
              ) : (
                <span className="ml-1 text-amber-500/80">
                  <Trans>· Сеньйора не призначено</Trans>
                </span>
              )}
            </p>
          )}
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5" />
              <Trans>Створено {formatDate(team.createdAt, locale, 'long')}</Trans>
            </div>
            {/* TG channel hidden from JUNIOR viewer per task #11 */}
            {team.telegram && viewerRole !== 'JUNIOR' && (
              <a
                href={tgUrl(team.telegram)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg border border-blue-500/50 px-4 py-2 text-sm font-medium text-blue-400 hover:bg-blue-500/10 hover:border-blue-400 transition-colors"
                data-testid="team-telegram-link"
              >
                <Send className="h-3 w-3" />
                <Trans>Telegram-чат</Trans>
              </a>
            )}
          </div>
        </div>
      </div>
      {/* ut-39b: "Actions" dropdown replaced with explicit Archive /
            Unarchive buttons (matches ut-28 project detail pattern).
            Add / Edit remain side-by-side; archive controls are admin-only. */}
      <div className="flex shrink-0 gap-2 flex-wrap justify-end">
        {/* Drop role - phase 1 (AC5): rotate-senior is the headline
              action for drop-teams. Senior-teams never see this button. */}
        {canRotateSenior && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={onRotateSenior}
            data-testid="team-rotate-senior-button"
          >
            <RefreshCw className="h-4 w-4" />
            {activeSenior ? t`Змінити сеньйора` : t`Призначити сеньйора`}
          </Button>
        )}
        {canManage && !team.archivedAt && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={onAddMember}
              data-testid="team-add-member-button"
            >
              <UserPlus className="h-4 w-4" />
              <Trans>Додати учасника</Trans>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              data-testid="team-edit-button"
              onClick={onEdit}
            >
              <Pencil className="h-4 w-4" />
              <Trans>Редагувати</Trans>
            </Button>
          </>
        )}
        {viewerRole === 'ADMIN' && !team.archivedAt && (
          <Button
            size="sm"
            variant="outline"
            onClick={onArchive}
            className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            data-testid="team-archive-button"
          >
            <Archive className="h-4 w-4" />
            <Trans>Архівувати</Trans>
          </Button>
        )}
        {viewerRole === 'ADMIN' && team.archivedAt && (
          <TeamUnarchiveHeaderButton teamId={team.id} />
        )}
      </div>
    </motion.div>
  )
}
