import { useMutation } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/axios'
import { Button } from '@/components/ui/button'
import type { SessionUser } from '@crm/shared'

interface ImpersonationBannerProps {
  /** The currently active session user (the impersonated target). */
  user: SessionUser
  /** Called on successful stop-impersonating so parent can invalidate auth. */
  onStopped: () => void
}

/**
 * Global sticky banner shown when an ADMIN is acting as another user.
 * Renders above the main content area (placed right after the header in CrmLayout).
 *
 * Design-gate: Tier 1 utilitarian; follows amber warning pattern from TosUpdateBanner.
 * Responsive: mobile (<640) stacks text + full-width button; tablet+ inline.
 */
export function ImpersonationBanner({ user, onStopped }: ImpersonationBannerProps) {
  const stopMutation = useMutation({
    mutationFn: async () => {
      await api.post('/auth/stop-impersonating')
    },
    onSuccess: () => {
      // Hard reload to root so all queries re-fetch as the restored admin.
      window.location.href = '/admin/login-as'
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Не удалось вернуться: ${msg}`)
      onStopped()
    },
  })

  const roleLabel: Record<string, string> = {
    SENIOR: 'Синьор',
    JUNIOR: 'Джун',
    HR: 'HR',
    ACCOUNTANT: 'Бухгалтер',
    DROP: 'Дроп',
  }
  const roleName = roleLabel[user.role] ?? user.role

  return (
    <motion.div
      role="alert"
      aria-live="polite"
      data-testid="impersonation-banner"
      className="shrink-0 border-b border-amber-500/50 bg-amber-500/10 px-4 py-2 sm:py-1.5"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        {/* Label */}
        <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          <span>
            Вы вошли как <span className="font-semibold">«{user.displayName}»</span>{' '}
            <span className="text-amber-600/80 dark:text-amber-400/80">({roleName})</span>
          </span>
        </div>

        {/* Return button */}
        <Button
          variant="outline"
          size="sm"
          className="min-h-[44px] w-full border-amber-500/40 text-amber-700 hover:bg-amber-500/10 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300 sm:w-auto sm:min-h-[36px]"
          aria-label="Вернуться в свой профиль"
          data-testid="impersonation-banner-return"
          disabled={stopMutation.isPending}
          onClick={() => stopMutation.mutate()}
        >
          {stopMutation.isPending ? 'Возврат...' : 'Вернуться в свой профиль'}
        </Button>
      </div>
    </motion.div>
  )
}
