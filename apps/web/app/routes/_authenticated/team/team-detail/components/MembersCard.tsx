import { Mail, Phone, Send, UserMinus } from 'lucide-react'
import { motion } from 'framer-motion'
import { useMemo } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import type { Role, TeamDto } from '@crm/shared'
import { getInitialsBySpaceSplit } from '@/lib/initials'
import { hasRealPhone } from '@/lib/format-phone'
import { tgUrl, tgDisplay } from '@/lib/tg-url'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ProfileNameLink } from '@/components/users/ProfileNameLink'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ROLE_LABEL_MESSAGES } from '@/components/ui/role-select'
import { ROLE_VARIANT } from '../constants'

/** Members card for the team detail page (RBAC visibility + removal matrix). */
export function MembersCard({
  members,
  viewerRole,
  viewerId,
  canManage,
  onRemove,
}: {
  members: TeamDto['members']
  viewerRole: Role | undefined
  viewerId: string | undefined
  canManage: boolean | undefined
  onRemove: (userId: string) => void
}) {
  const { t, i18n } = useLingui()
  // Pre-compute members grouped by role once per members change (avoids the
  // O(N^2) per-member reduce inside the JSX .map()).
  const membersByRole = useMemo(
    () =>
      members.reduce(
        (acc, m) => {
          if (!acc[m.role]) acc[m.role] = []
          acc[m.role]!.push(m)
          return acc
        },
        {} as Record<string, TeamDto['members']>,
      ),
    [members],
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Trans>Учасники команди</Trans>
          <Badge variant="outline" className="ml-auto">
            {members.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {(() => {
          // RBAC member visibility:
          // JUNIOR viewer → hide all JUNIORs (sees non-junior roster only).
          // SENIOR viewer → hide all JUNIORs (identity hidden per RBAC rule #1).
          // Other roles → full member list.
          const visibleMembers =
            viewerRole === 'JUNIOR' || viewerRole === 'SENIOR'
              ? members.filter((m) => m.role !== 'JUNIOR')
              : members

          return (
            <div className="grid gap-2 sm:grid-cols-2">
              {visibleMembers.map((member) => (
                <motion.div
                  key={member.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/50 p-3"
                  whileHover={{ scale: 1.01 }}
                  transition={{ duration: 0.15 }}
                >
                  {/* round-2 AC1: avatar + name is the only profile <Link>;
                    email/telegram/phone are sibling <a> tags (NOT nested
                    inside another anchor) — fixes validateDOMNesting.
                    task-drop-profile-lockdown: for a DROP viewer these
                    become plain (non-navigable) — DROP has no profile
                    access. Contacts below stay visible. */}
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <ProfileNameLink
                      userId={member.userId}
                      viewerRole={viewerRole ?? 'JUNIOR'}
                      className="shrink-0 transition-opacity hover:opacity-80"
                    >
                      <Avatar className="h-9 w-9 shrink-0">
                        {member.avatarUrl && (
                          <AvatarImage src={member.avatarUrl} alt={member.displayName} />
                        )}
                        <AvatarFallback className="bg-muted text-xs">
                          {getInitialsBySpaceSplit(member.displayName)}
                        </AvatarFallback>
                      </Avatar>
                    </ProfileNameLink>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <ProfileNameLink
                          userId={member.userId}
                          viewerRole={viewerRole ?? 'JUNIOR'}
                          className="min-w-0 transition-opacity hover:opacity-80"
                        >
                          <p className="truncate text-sm font-medium leading-tight hover:text-primary transition-colors">
                            {member.displayName}
                          </p>
                        </ProfileNameLink>
                        <Badge
                          variant={ROLE_VARIANT[member.role] ?? 'junior'}
                          className="text-[9px] shrink-0"
                        >
                          {i18n._(ROLE_LABEL_MESSAGES[member.role])}
                        </Badge>
                      </div>
                      {Array.isArray(member.techStack) && member.techStack.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {(member.techStack as string[]).map((t) => (
                            <Badge
                              key={t}
                              variant="outline"
                              className="text-[9px] px-1.5 py-0 font-mono"
                            >
                              {t}
                            </Badge>
                          ))}
                        </div>
                      )}
                      <div className="mt-1 flex flex-col gap-0.5 min-w-0">
                        <a
                          href={`mailto:${member.email}`}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors min-w-0"
                        >
                          <Mail className="h-3 w-3 shrink-0" />
                          <span className="truncate">{member.email}</span>
                        </a>
                        {member.telegram && (
                          <a
                            href={tgUrl(member.telegram)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors min-w-0"
                          >
                            <Send className="h-3 w-3 shrink-0" />
                            <span className="truncate">{tgDisplay(member.telegram)}</span>
                          </a>
                        )}
                        {hasRealPhone(member.phone) && (
                          <a
                            href={`tel:${member.phone}`}
                            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors min-w-0"
                          >
                            <Phone className="h-3 w-3 shrink-0" />
                            <span className="truncate">{member.phone}</span>
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                  {canManage &&
                    (() => {
                      // membersByRole is pre-computed above via useMemo([members])
                      const isSenior = member.role === 'SENIOR'
                      const isJunior = member.role === 'JUNIOR'
                      const isLastHr =
                        member.role === 'HR' && membersByRole.HR && membersByRole.HR.length <= 1
                      const isLastAccountant =
                        member.role === 'ACCOUNTANT' &&
                        membersByRole.ACCOUNTANT &&
                        membersByRole.ACCOUNTANT.length <= 1
                      const isSelf = member.userId === viewerId
                      const canRemove =
                        !isSenior &&
                        !isJunior &&
                        !isLastHr &&
                        !isLastAccountant &&
                        (viewerRole === 'ADMIN' ? true : isSelf)
                      return canRemove ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                          title={t`Виключити`}
                          onClick={() => onRemove(member.userId)}
                        >
                          <UserMinus className="h-3.5 w-3.5" />
                        </Button>
                      ) : null
                    })()}
                </motion.div>
              ))}
              {visibleMembers.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 text-center col-span-2">
                  <p className="mt-3 text-sm font-medium">
                    <Trans>Немає учасників</Trans>
                  </p>
                </div>
              )}
            </div>
          )
        })()}
      </CardContent>
    </Card>
  )
}
