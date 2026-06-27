import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { motion } from 'framer-motion'
import { AlertCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { AuthProvider, useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { BrandMark } from '@/components/brand-mark'

const searchSchema = z.object({
  error: z.enum(['unauthorized', 'google_error', 'invalid_state']).optional(),
})

export const Route = createFileRoute('/login')({
  validateSearch: searchSchema,
  component: LoginRoot,
})

function LoginRoot() {
  // No `skip` flag — we WANT `/auth/me` to fire so the page can detect an
  // already-authenticated user and redirect them to the CRM. When the user
  // is unauthenticated, /auth/me returns 401 (handled inside fetchMe) and
  // `useAuth().user` settles to `null` after one quick request.
  return (
    <AuthProvider>
      <LoginPage />
    </AuthProvider>
  )
}

// Show Dev Login section when:
//   • running `pnpm dev` (import.meta.env.DEV === true), or
//   • building with VITE_DEV_LOGIN=true for User Testing through tunnel
//     (Google OAuth fails on phone via tunnel — redirect_uri_mismatch).
// In real production builds both are false → section is hidden AND tree-shaken.
const SHOW_DEV_LOGIN = import.meta.env.DEV || import.meta.env['VITE_DEV_LOGIN'] === 'true'

// Security: DEV_USERS is defined inside the SHOW_DEV_LOGIN branch (see DevLoginSection)
// so that Vite's tree-shaker can eliminate it from production bundles when
// VITE_DEV_LOGIN is not set. Keeping real emails outside that branch would embed
// them as string literals in every build regardless of the flag.

const ERROR_MESSAGES: Record<string, string> = {
  unauthorized: 'Ваш email не авторизован. Обратитесь к администратору.',
  google_error: 'Ошибка Google OAuth. Попробуйте снова.',
  invalid_state: 'Сессия истекла. Пожалуйста, попробуйте снова.',
}

const API_URL = import.meta.env['VITE_API_URL'] ?? 'http://localhost:3001/api'

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  )
}

// DEV_USERS is defined inside DevLoginSection (not at module top-level) so that
// Vite's tree-shaker can drop this entire component — including the email
// literals — when SHOW_DEV_LOGIN is false (production build without the flag).
// If defined at module scope, the array would be a static string constant that
// bundlers include unconditionally regardless of the conditional render above.
function DevLoginSection({
  devLoading,
  setDevLoading,
}: {
  devLoading: string | null
  setDevLoading: (v: string | null) => void
}) {
  // Email addresses are dev/staging placeholders that map to seeded DB accounts.
  // Keeping them here (not at module scope) prevents them from being bundled into
  // production output when VITE_DEV_LOGIN is not set.
  const DEV_USERS = [
    { email: 'admin@example.dev', label: 'Admin 1 — ADMIN' },
    { email: 'admin2@example.dev', label: 'Admin 2 — ADMIN' },
    { email: 'senior1@example.dev', label: 'Senior 1 — SENIOR' },
    { email: 'senior2@example.dev', label: 'Senior 2 — SENIOR' },
    { email: 'junior1@example.dev', label: 'Junior 1 — JUNIOR' },
    { email: 'junior2@example.dev', label: 'Junior 2 — JUNIOR' },
    { email: 'hr1@example.dev', label: 'HR 1 — HR' },
    { email: 'hr2@example.dev', label: 'HR 2 — HR' },
    { email: 'accountant@example.dev', label: 'Accountant — ACCOUNTANT' },
    { email: 'drop@example.dev', label: 'Drop — DROP' },
  ]

  return (
    <div
      className="mt-6 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4"
      data-testid="dev-login-section"
    >
      <div className="mb-3 flex items-center gap-2">
        <span className="text-amber-400" aria-hidden="true">
          🔧
        </span>
        <h3 className="text-sm font-medium text-amber-400">Dev Login (только для тестирования)</h3>
      </div>
      <div className="flex flex-col gap-1.5">
        {DEV_USERS.map((u) => (
          <button
            key={u.email}
            type="button"
            data-testid={`dev-login-${u.email}`}
            disabled={devLoading !== null}
            onClick={async () => {
              setDevLoading(u.email)
              try {
                await api.post('/auth/dev-login', { email: u.email })
                window.location.href = '/'
              } catch {
                setDevLoading(null)
              }
            }}
            className="flex w-full items-center gap-2 rounded-md border border-amber-500/20 bg-background/60 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-foreground disabled:opacity-50"
          >
            <span className="flex-1">{u.label}</span>
            {devLoading === u.email && (
              <span
                className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent"
                aria-hidden="true"
              />
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

function LoginPage() {
  const { user, isLoading } = useAuth()
  const navigate = useNavigate()
  const { error } = Route.useSearch()
  const [devLoading, setDevLoading] = useState<string | null>(null)

  // Redirect if already authenticated. `replace: true` prevents the browser
  // back-button from returning to /login after a successful redirect into
  // the app — otherwise the user can land back on the login page after the
  // first navigation. AuthProvider is mounted WITHOUT `skip` here, so this
  // effect actually fires (see LoginRoot comment above).
  useEffect(() => {
    if (!isLoading && user) {
      void navigate({ to: '/', replace: true })
    }
  }, [user, isLoading, navigate])

  // round-2 AC3: Google One Tap auto-prompt removed. It previously initialised
  // GSI and called prompt() on mount, firing a FedCM credential request. With no
  // signed-in Google account in the browser that request rejects and floods the
  // console with noise:
  //   [GSI_LOGGER] FedCM get() rejects with NetworkError
  //   "Not signed in with the identity provider"
  // The primary (and only tested) auth path is the server-side redirect button
  // below (<a href=".../auth/google">), which does NOT depend on GSI at all.
  // One Tap was purely supplementary, so dropping the auto-prompt removes the
  // console noise with zero risk to the OAuth flow.

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <motion.div
        className="w-full max-w-sm"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] as const }}
      >
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <BrandMark className="h-14 w-14 text-primary drop-shadow-lg" />
          <div>
            <h1 className="text-xl font-bold tracking-tight">CheekyCheeseIT CRM</h1>
            <p className="mt-1 text-sm text-muted-foreground">Войдите через корпоративный Google</p>
          </div>
          <Badge variant="outline" className="border-primary/30 text-primary text-xs">
            Только для сотрудников
          </Badge>
        </div>

        {/* Error */}
        {error && (
          <motion.div
            className="mb-4 flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            data-testid="login-error-message"
            data-error-code={error}
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{ERROR_MESSAGES[error]}</span>
          </motion.div>
        )}

        {/* Fallback OAuth button */}
        <Button
          asChild
          variant="outline"
          size="lg"
          className="w-full gap-3 border-border/80 bg-card hover:bg-accent"
        >
          <a href={`${API_URL}/auth/google`} data-testid="login-google-button">
            <GoogleIcon />
            Войти с Google
          </a>
        </Button>

        {SHOW_DEV_LOGIN && (
          // DevLoginSection is rendered (and its DEV_USERS array instantiated) only
          // when SHOW_DEV_LOGIN is truthy — keeping the email literals inside this
          // branch ensures they are tree-shaken out of production builds.
          <DevLoginSection devLoading={devLoading} setDevLoading={setDevLoading} />
        )}

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Доступ только для авторизованных сотрудников.
          <br />
          Если у вас нет доступа — обратитесь к администратору.
        </p>
      </motion.div>
    </div>
  )
}
