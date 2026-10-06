import { Link } from '@tanstack/react-router'
import { Briefcase } from 'lucide-react'
import { Trans } from '@lingui/react/macro'
import type { ProjectDto, Role, TeamDto } from '@crm/shared'
import { getInitialsBySpaceSplit } from '@/lib/initials'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ProjectLogo } from '@/components/projects/ProjectLogo'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

/** Active Projects card for the team detail page (display-only). */
export function ActiveProjectsCard({
  visibleProjects,
  viewerRole,
  members,
}: {
  visibleProjects: ProjectDto[]
  viewerRole: Role | undefined
  members: TeamDto['members']
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Briefcase className="h-5 w-5" />
          <Trans>Активні проєкти</Trans>
          {visibleProjects.length > 0 && (
            <Badge className="ml-auto bg-emerald-500/15 text-emerald-400 border-emerald-500/25 hover:bg-emerald-500/20">
              {visibleProjects.length}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {visibleProjects.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            <Trans>Немає активних проєктів</Trans>
          </p>
        ) : (
          <div className="space-y-2">
            {visibleProjects.map((project) => {
              const juniorMember = project.members?.find(
                (m: { role: string; leftAt: string | null }) =>
                  m.role === 'JUNIOR' && m.leftAt === null,
              )
              // RBAC rule #1: SENIOR viewer must not see junior identity.
              // junior slot still visible (project has a junior), but name/avatar hidden.
              const showJuniorIdentity = viewerRole !== 'SENIOR'
              const junior =
                showJuniorIdentity && juniorMember
                  ? members.find((m) => m.userId === juniorMember.userId)
                  : null
              return (
                <Link
                  key={project.id}
                  to="/projects/$projectId"
                  params={{ projectId: project.id }}
                  className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/50 p-3 transition-all hover:border-primary/30 hover:bg-card"
                >
                  <ProjectLogo
                    documentId={project.logoDocumentId}
                    externalUrl={project.logoExternalUrl}
                    companyName={project.companyName}
                    fallback={project.companyName.slice(0, 2).toUpperCase()}
                    avatarClassName="h-8 w-8 rounded-md shrink-0 [&_[data-slot=avatar-fallback]]:rounded-md [&_[data-slot=avatar-fallback]]:text-xs"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{project.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{project.companyName}</p>
                    {junior ? (
                      <div
                        className="flex items-center gap-1.5 mt-1"
                        data-testid="project-junior-slot"
                      >
                        <Avatar className="h-4 w-4">
                          {junior.avatarUrl && (
                            <AvatarImage src={junior.avatarUrl} alt={junior.displayName} />
                          )}
                          <AvatarFallback className="bg-muted text-[8px]">
                            {getInitialsBySpaceSplit(junior.displayName)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-xs text-muted-foreground truncate">
                          {junior.displayName}
                        </span>
                      </div>
                    ) : juniorMember && !showJuniorIdentity ? (
                      // SENIOR viewer: slot occupied but identity hidden
                      <p className="text-xs text-muted-foreground/60 mt-1">
                        <Trans>Джуніора призначено</Trans>
                      </p>
                    ) : (
                      <p className="text-xs text-destructive mt-1">
                        <Trans>Джуніора не призначено</Trans>
                      </p>
                    )}
                  </div>
                  <Badge className="shrink-0 bg-emerald-500/15 text-emerald-400 border-emerald-500/25 text-[10px]">
                    <Trans>Активний</Trans>
                  </Badge>
                </Link>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
