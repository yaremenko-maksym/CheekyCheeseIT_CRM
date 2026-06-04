import { Info } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { Alert, AlertDescription } from '@/components/ui/alert'

/**
 * Sticky soft-notify banner that appears when a user has already completed
 * onboarding (requiresTos=false) but a newer ToS version is available
 * (tosUpdateAvailable=true).
 *
 * The banner is NOT dismissible — it persists until the user reads and
 * accepts the new version via /crm/onboarding?step=tos.
 */
export function TosUpdateBanner() {
  return (
    <Alert
      data-testid="tos-update-banner"
      className="rounded-none border-x-0 border-t-0 bg-primary/5 px-6 py-2.5"
    >
      <Info className="h-4 w-4 text-primary" />
      <AlertDescription className="flex items-center gap-2 text-sm">
        Опубликована новая версия Terms of Service.{' '}
        <Link
          to="/crm/onboarding"
          search={{ step: 'tos' }}
          className="font-medium text-primary underline-offset-2 hover:underline"
          data-testid="tos-update-banner-link"
        >
          Читать →
        </Link>
      </AlertDescription>
    </Alert>
  )
}
