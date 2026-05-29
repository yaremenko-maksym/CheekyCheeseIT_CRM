import { Link } from '@tanstack/react-router'
import { Compass, Home } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Styled catch-all 404 — wired as the router's `defaultNotFoundComponent`
 * (see app/router.tsx). Replaces TanStack Router's bare «Not Found» text with
 * an empty-state in the app's visual language: muted icon, big code, Russian
 * copy and a primary «На главную» link back to the CRM workspace.
 */
export function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-muted/30 text-muted-foreground">
        <Compass className="h-8 w-8" />
      </div>
      <p className="mt-6 text-5xl font-bold tracking-tight tabular-nums text-foreground/90">404</p>
      <h1 className="mt-2 text-lg font-semibold tracking-tight">Страница не найдена</h1>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Возможно, ссылка устарела или страница была перемещена.
      </p>
      <Button asChild className="mt-6" data-testid="not-found-home-link">
        <Link to="/crm">
          <Home className="mr-2 h-4 w-4" />
          На главную
        </Link>
      </Button>
    </div>
  )
}
