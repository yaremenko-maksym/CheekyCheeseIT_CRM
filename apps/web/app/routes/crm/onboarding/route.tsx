import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import type { OnboardingStatusDto } from '@crm/shared'
import { BrandMark } from '@/components/brand-mark'
import { Skeleton } from '@/components/ui/skeleton'

export const Route = createFileRoute('/crm/onboarding')({
  component: OnboardingRoot,
})

function OnboardingRoot() {
  const { user, isLoading: authLoading } = useAuth()
  const navigate = useNavigate()

  const { data: status, isLoading: statusLoading } = useQuery<OnboardingStatusDto>({
    queryKey: ['onboarding-status'],
    queryFn: async () => {
      const res = await api.get<OnboardingStatusDto>('/onboarding/status')
      return res.data
    },
    enabled: !!user,
    staleTime: 0, // always fresh on onboarding page
  })

  // If user doesn't need onboarding → redirect to dashboard
  useEffect(() => {
    if (!status) return
    if (!status.requiresContract && !status.requiresTos) {
      void navigate({ to: '/crm/dashboard' })
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
