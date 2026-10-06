import { Link } from '@tanstack/react-router'
import { ArrowLeft, Users } from 'lucide-react'
import { Trans } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'

/** Not-found / no-access state for the team detail page. */
export function TeamNotFound({ userRole }: { userRole: string | undefined }) {
  return (
    <div
      className="flex flex-col items-center justify-center py-24 text-center"
      data-testid="team-not-found"
    >
      <Users className="h-10 w-10 text-muted-foreground/30" />
      <p className="mt-4 text-sm font-medium">
        <Trans>Команду не знайдено</Trans>
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        <Trans>Можливо, у вас немає доступу до цієї команди</Trans>
      </p>
      {/* the back-to-list button is hidden for DROP: nowhere to go back to. */}
      {userRole !== 'DROP' && (
        <Button asChild variant="outline" size="sm" className="mt-4">
          <Link to="/team">
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            <Trans>Повернутися до списку</Trans>
          </Link>
        </Button>
      )}
    </div>
  )
}
