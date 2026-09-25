import { Link } from '@tanstack/react-router'
import { ExternalLink } from 'lucide-react'
import { Trans } from '@lingui/react/macro'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

export function InterviewsTab({ seniorId }: { seniorId: string }) {
  return (
    <Card>
      <CardContent className="pt-6 text-center">
        <p className="mb-4 text-sm text-muted-foreground">
          <Trans>Дошка співбесід цього сеньйора</Trans>
        </p>
        <Button asChild>
          <Link to="/interviews" search={{ seniorId }}>
            <ExternalLink className="mr-2 h-4 w-4" />
            <Trans>Відкрити дошку</Trans>
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}
