import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { useLogout } from '@/lib/use-logout'
import type { OnboardingStatusDto } from '@crm/shared'
import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { LogOut } from 'lucide-react'

export const Route = createFileRoute('/crm/onboarding')({
  component: OnboardingRoot,
})

function OnboardingRoot() {
  const { user, isLoading: authLoading } = useAuth()
  const navigate = useNavigate()
  const logout = useLogout()

  const { data: status, isLoading: statusLoading } = useQuery<OnboardingStatusDto>({
    queryKey: ['onboarding-status'],
    queryFn: async () => {
      const res = await api.get<OnboardingStatusDto>('/onboarding/status')
      return res.data
    },
    enabled: !!user,
    staleTime: 0, // always fresh on onboarding page
  })

  // If user doesn't need onboarding → redirect to dashboard (/crm)
  useEffect(() => {
    if (!status) return
    if (!status.requiresContract && !status.requiresTos) {
      void navigate({ to: '/crm' })
    }
  }, [status, navigate])

  // Auth guard
  useEffect(() => {
    if (!authLoading && !user) {
      void navigate({ to: '/crm/login' })
    }
  }, [user, authLoading, navigate])

  if (authLoading || (user && statusLoading)) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-background">
        <Skeleton className="h-10 w-64 mb-4" />
        <Skeleton className="h-6 w-40" />
      </div>
    )
  }

  if (!user) return null

  return (
    // Full-screen layout without sidebar — wizard card is centred
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-background px-4 py-12">
      {/* Logout button — top-right corner, always accessible even without sidebar */}
      <div className="absolute right-4 top-4 flex items-center gap-2 sm:gap-3">
        <span
          className="hidden text-sm text-muted-foreground sm:inline"
          data-testid="onboarding-user-email"
        >
          {user.email}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={logout}
          data-testid="onboarding-logout"
        >
          <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
          Выйти
        </Button>
      </div>

      {/* Brand header */}
      <div className="mb-8 flex items-center gap-3">
        <BrandMark className="h-8 w-8 text-primary" />
        <span className="text-xl font-semibold tracking-tight">CheekyCheeseIT CRM</span>
      </div>

      {/* Wizard card */}
      <div className="w-full max-w-2xl rounded-2xl border border-border bg-card p-4 sm:p-8 shadow-lg">
        <Outlet />
      </div>

      {/* Footer */}
      <p className="mt-6 text-xs text-muted-foreground">
        © {new Date().getFullYear()} Cheeky Cheese IT. Все права защищены.
      </p>
    </div>
  )
}
