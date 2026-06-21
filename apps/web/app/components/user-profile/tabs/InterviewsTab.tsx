import { Link } from '@tanstack/react-router'
import { ExternalLink } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

export function InterviewsTab({ seniorId }: { seniorId: string }) {
  return (
    <Card>
      <CardContent className="pt-6 text-center">
        <p className="mb-4 text-sm text-muted-foreground">Доска собеседований этого синьора</p>
        <Button asChild>
          <Link to="/interviews" search={{ seniorId }}>
            <ExternalLink className="mr-2 h-4 w-4" />
            Открыть Канбан
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}
