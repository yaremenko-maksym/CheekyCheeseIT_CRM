import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { motion } from 'framer-motion'
import { AlertCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { AuthProvider, useAuth } from '../../context/auth'
import { api } from '../../lib/axios'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'

const searchSchema = z.object({
  error: z.enum(['unauthorized', 'google_error', 'invalid_state']).optional(),
})

export const Route = createFileRoute('/crm_/login')({
  validateSearch: searchSchema,
  component: LoginRoot,
})

function LoginRoot() {
  return (
    <AuthProvider skip>
      <LoginPage />
    </AuthProvider>
  )
}

const IS_DEV = import.meta.env.DEV

const DEV_USERS = [
  { email: 'yaremenkomaksym99@gmail.com', label: 'Maksym Yaremenko — ADMIN' },
  { email: 'kostya@cheekycheeseit.com', label: 'Kostya — ADMIN' },
  { email: 'oleksiy.kovalenko@cheekycheese.dev', label: 'Oleksiy Kovalenko — SENIOR' },
  { email: 'dmytro.marchenko@cheekycheese.dev', label: 'Dmytro Marchenko — SENIOR' },
  { email: 'sofia.bondarenko@cheekycheese.dev', label: 'Sofia Bondarenko — JUNIOR' },
  { email: 'ivan.petrenko@cheekycheese.dev', label: 'Ivan Petrenko — JUNIOR' },
  { email: 'anna.lysenko@cheekycheese.dev', label: 'Anna Lysenko — HR' },
  { email: 'kateryna.shevchenko@cheekycheese.dev', label: 'Kateryna Shevchenko — HR' },
  { email: 'mykola.savchenko@cheekycheese.dev', label: 'Mykola Savchenko — ACCOUNTANT' },
]

const ERROR_MESSAGES: Record<string, string> = {
  unauthorized: 'Ваш email не авторизован. Обратитесь к администратору.',
  google_error: 'Ошибка Google OAuth. Попробуйте снова.',
  invalid_state: 'Сессия истекла. Пожалуйста, попробуйте снова.',
}

const API_URL = import.meta.env['VITE_API_URL'] ?? 'http://localhost:3001/api'
const GOOGLE_CLIENT_ID = import.meta.env['VITE_GOOGLE_CLIENT_ID'] ?? ''

declare global {
  interface Window {
    __gsiInitialized?: boolean
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string
            callback: (res: { credential: string }) => void
            use_fedcm_for_prompt?: boolean
            cancel_on_tap_outside?: boolean
          }) => void
          prompt: () => void
          cancel: () => void
        }
      }
    }
  }
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  )
}

function LoginPage() {
  const { user, isLoading } = useAuth()
  const navigate = useNavigate()
  const { error } = Route.useSearch()
  const scriptRef = useRef<HTMLScriptElement | null>(null)
  const [devLoading, setDevLoading] = useState<string | null>(null)

  // Redirect if already authenticated
  useEffect(() => {
    if (!isLoading && user) {
      void navigate({ to: '/crm' })
    }
  }, [user, isLoading, navigate])

  // Load Google Identity Services and show One Tap prompt
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || isLoading || user) return

    // Prevent double-init from React StrictMode
    if (window.__gsiInitialized) return
    window.__gsiInitialized = true

    const handleCredential = async (response: { credential: string }) => {
      try {
        await api.post('/auth/google/one-tap', { credential: response.credential })
        // Full page reload so the new JWT cookie is picked up by AuthProvider fresh
        window.location.href = '/crm'
      } catch {
        window.location.href = '/crm/login?error=google_error'
      }
    }

    const initOneTap = () => {
      window.google?.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleCredential,
        use_fedcm_for_prompt: false,
        cancel_on_tap_outside: false,
      })
      window.google?.accounts.id.prompt()
    }

    if (window.google) {
      initOneTap()
      return () => { window.__gsiInitialized = false }
    }

    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.onload = initOneTap
    document.head.appendChild(script)
    scriptRef.current = script

    return () => {
      window.__gsiInitialized = false
      window.google?.accounts.id.cancel()
      if (scriptRef.current) {
        document.head.removeChild(scriptRef.current)
        scriptRef.current = null
      }
    }
  }, [isLoading, user, navigate])

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
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary shadow-lg shadow-primary/30">
            <span className="text-xl font-black text-primary-foreground">CC</span>
          </div>
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
          <a href={`${API_URL}/auth/google`}>
            <GoogleIcon />
            Войти с Google
          </a>
        </Button>

        {IS_DEV && (
          <div className="mt-6">
            <div className="relative flex items-center gap-2 py-2">
              <div className="h-px flex-1 bg-border/50" />
              <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground/60">
                Dev login
              </span>
              <div className="h-px flex-1 bg-border/50" />
            </div>
            <div className="mt-2 flex flex-col gap-1.5">
              {DEV_USERS.map((u) => (
                <button
                  key={u.email}
                  disabled={devLoading !== null}
                  onClick={async () => {
                    setDevLoading(u.email)
                    try {
                      await api.post('/auth/dev-login', { email: u.email })
                      window.location.href = '/crm'
                    } catch {
                      setDevLoading(null)
                    }
                  }}
                  className="flex w-full items-center gap-2 rounded-md border border-border/40 bg-muted/30 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
                >
                  <span className="flex-1">{u.label}</span>
                  {devLoading === u.email && (
                    <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
                  )}
                </button>
              ))}
            </div>
          </div>
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
