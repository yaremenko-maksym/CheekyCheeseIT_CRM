import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { motion } from 'framer-motion'
import { AlertCircle, CheckCircle2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { AuthProvider, useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { BrandMark } from '@/components/brand-mark'

// copy-review PR #623 round 4 (COPY-M-8): `ERROR_MESSAGES` is now the ONE
// source of truth for which `?error=` codes this page understands —
// `searchSchema` below DERIVES its accepted values from these keys instead
// of maintaining a second, hand-written list. Before this, the two lists
// were independent: `AuthController.googleCallback`'s ordinary login path
// (NOT the invite branch) started emitting `account_mismatch` /
// `account_disabled`, nobody added them here, and `z.enum([...])` — which
// `validateSearch` calls `.parse()` on internally — threw `SearchParamError`
// on a REAL redirect, crashing to the generic error boundary. That is the
// exact same crash class `?invited=1` hit (see the coercion comment below) —
// this time from the accepted-values list going stale, not the value shape.
// A single source of truth makes that specific divergence impossible: a
// code cannot be "in ERROR_MESSAGES but not in the schema" or vice versa,
// because the schema no longer HAS an independent list to fall behind.
//
// Exported for `__tests__/login.search-schema.spec.ts` — every entry here
// was a `[Survived] StringLiteral` mutant (Stryker mutated e.g.
// `'unauthorized'` → `''`) until that file pinned each one individually:
// only Playwright E2E (which Stryker cannot execute) previously exercised
// these exact strings end-to-end — see
// `.claude/rules/common/mutation-gate-integration-specs.md`.
export const ERROR_MESSAGES = {
  unauthorized: 'Ваш email не авторизован. Обратитесь к администратору.',
  google_error: 'Ошибка Google OAuth. Попробуйте снова.',
  invalid_state: 'Сессия истекла. Пожалуйста, попробуйте снова.',
  // task-user-emails-invite (spec §2, §3) + copy-review PR #623 round 4
  // (COPY-H-3): the invite-accept branch of GET /auth/google/callback
  // (AuthController) redirects here on failure — see `mapInviteAcceptError`
  // in that file for the exception → code mapping. Names the most likely
  // next action (open the link again and pick the right Google account —
  // the link stays valid, `acceptPersonalEmailInvite` does not consume the
  // token on a mismatch) instead of only naming the diagnosis; the account
  // chooser this relies on is forced open by `prompt=select_account`
  // (`AuthService.buildGoogleAuthUrl`, invite round only).
  invite_email_mismatch:
    'Вы вошли в другой аккаунт Google. Откройте ссылку из письма ещё раз и выберите аккаунт того адреса, на который оно пришло. Если аккаунта Google на этом адресе нет — войти по нему нельзя, напишите администратору.',
  invite_expired: 'Срок действия приглашения истёк. Попросите администратора отправить его заново.',
  // COPY-M-2: `usedAt` and `canLogin=true` are set in the SAME transaction
  // (UsersService.acceptPersonalEmailInvite) — "already used" always means
  // "already works as a login method", so the next action is the ordinary
  // Google button below, not a dead end.
  invite_used:
    'Приглашение уже использовано — личный адрес подтверждён. Войдите через Google кнопкой ниже.',
  // COPY-M-3: the most common real path to this code is a resend, which
  // OVERWRITES the old token hash (issuePersonalEmailInviteTx) — the old
  // link the person may still have open genuinely stops matching anything,
  // and the fix is the newer email, not retrying the same link.
  invite_invalid:
    'Ссылка не работает. Откройте ссылку из последнего письма, а если его нет — попросите администратора прислать приглашение заново.',
  // LOW-1 (security-review PR #623 round 4): distinct from invite_used —
  // this Google account is already the login method for a DIFFERENT
  // address, not the one this link was for.
  invite_account_taken:
    'Этот аккаунт Google уже используется для входа с другого адреса. Обратитесь к администратору.',
  // COPY-M-8: both codes below are emitted by the ORDINARY (non-invite)
  // login path (`AuthController.googleCallback`) and previously had no
  // text at all — an unrecognised `error` value crashed `validateSearch`
  // the same way `?invited=1` once did (see the module doc above).
  account_mismatch:
    'Этот адрес уже привязан к другому аккаунту Google. Войдите тем аккаунтом, которым входили раньше, или напишите администратору.',
  // LOW-2 (security-review PR #623 round 4): also reachable from the
  // invite-accept branch when the target was archived AFTER the invite was
  // issued — same code, same text, same "nothing to retry" framing.
  account_disabled: 'Доступ к CRM закрыт. Если это ошибка, напишите администратору.',
} as const satisfies Record<string, string>

/** Non-empty tuple `z.enum` requires — derived from `ERROR_MESSAGES`'s own
 * keys so the two can never diverge (see the doc above). */
const ERROR_CODES = Object.keys(ERROR_MESSAGES) as [
  keyof typeof ERROR_MESSAGES,
  ...(keyof typeof ERROR_MESSAGES)[],
]

// TanStack Router's default search-param parser treats a numeric-looking
// query string (`?invited=1`) as the JSON number `1`, not the string `'1'`,
// before this schema ever sees it (confirmed live: `z.enum(['1'])` threw
// `SearchParamError` and crashed the route on a real `?invited=1` redirect —
// no test caught it because nothing exercised the schema against the
// router's actual parsed shape). `z.coerce.boolean()` is the same fix
// already used for `archived` in `_authenticated/users/index.tsx` for the
// identical reason.
export const searchSchema = z.object({
  error: z.enum(ERROR_CODES).optional(),
  // Set on success by the SAME redirect — see AuthController.googleCallback's
  // invite branch. Deliberately NOT an error: task §2 — "Токен НЕ выдаёт
  // сессию", so the person still has to click "Войти с Google" below to
  // actually sign in; this banner just confirms the accept step worked.
  // `z.coerce.boolean()`, not `z.enum(['1'])`: the router's default search
  // parser turns `?invited=1` into the NUMBER 1 before this schema runs
  // (see the module doc comment above and `login.search-schema.spec.ts`).
  invited: z.coerce.boolean().optional(),
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

// Dev-login visibility gate: import.meta.env.PROD is a static boolean that
// Vite replaces at build time (true in prod, false in dev). Using PROD (not DEV
// or bracket-access VITE_DEV_LOGIN) guarantees Rollup dead-code-eliminates the
// entire DevLoginSection — including email literals — from production bundles.
// import.meta.env['VITE_DEV_LOGIN'] (bracket access) is NOT statically foldable
// by Vite/Rollup and keeps the component in the bundle even when the flag is unset.
const SHOW_DEV_LOGIN = !import.meta.env.PROD

// Security: DEV_USERS is defined at module scope (exported for unit tests — Fix#3).
// Rollup eliminates it from prod bundles alongside DevLoginSection because
// SHOW_DEV_LOGIN = !import.meta.env.PROD is statically false in prod builds,
// making all references inside DevLoginSection unreachable dead code.

// Dot access — hotfix (task-telemetry-env-gate): bracket access to
// `import.meta.env.VITE_*` is NOT statically foldable by Vite (same pitfall
// the `SHOW_DEV_LOGIN` comment above already flagged for VITE_DEV_LOGIN) —
// this line was silently falling back to the localhost dev URL in EVERY prod
// build, breaking the "Войти через Google" link whenever VITE_API_URL was
// actually overridden away from the relative-`/api` default.
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api'

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

// DEV_USERS is exported for unit tests (Fix#3) so tests import the real constant
// instead of an inline mirror. Rollup eliminates this array from production bundles
// alongside DevLoginSection — both are only reachable when SHOW_DEV_LOGIN is true
// (!import.meta.env.PROD), which Rollup statically folds to false in prod builds,
// marking all code paths through DevLoginSection as dead code.
export const DEV_USERS = [
  { email: 'yaremenkomaksym99@gmail.com', label: 'Admin 1 — ADMIN (Maksym)' },
  { email: 'kostya@cheekycheeseit.com', label: 'Admin 2 — ADMIN (Kostya)' },
  { email: 'oleksiy.kovalenko@cheekycheese.dev', label: 'Senior 1 — SENIOR (Oleksiy)' },
  { email: 'dmytro.marchenko@cheekycheese.dev', label: 'Senior 2 — SENIOR (Dmytro)' },
  { email: 'sofia.bondarenko@cheekycheese.dev', label: 'Junior 1 — JUNIOR (Sofia)' },
  { email: 'ivan.petrenko@cheekycheese.dev', label: 'Junior 2 — JUNIOR (Ivan)' },
  { email: 'anna.lysenko@cheekycheese.dev', label: 'HR 1 — HR (Anna)' },
  { email: 'kateryna.shevchenko@cheekycheese.dev', label: 'HR 2 — HR (Kateryna)' },
  { email: 'mykola.savchenko@cheekycheese.dev', label: 'Accountant — ACCOUNTANT (Mykola)' },
  { email: 'viktor.drop@cheekycheese.dev', label: 'Drop — DROP (Viktor)' },
]

function DevLoginSection({
  devLoading,
  setDevLoading,
}: {
  devLoading: string | null
  setDevLoading: (v: string | null) => void
}) {
  // DEV_USERS is defined at module scope (exported for unit tests — Fix#3).
  // It is only used inside this component; Rollup eliminates it from prod bundles
  // together with DevLoginSection because SHOW_DEV_LOGIN = !import.meta.env.PROD
  // is statically false in production, making this component unreachable dead code.

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
  const { error, invited } = Route.useSearch()
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
            {/* copy-review PR #623 round 4 (COPY-H-2): "корпоративный" is now
                actively wrong on this page — a just-confirmed PERSONAL address
                sits right below this subtitle (the `invited` banner) and is
                also a valid way to sign in via the SAME button. "Только для
                сотрудников" (badge below) already carries the access
                restriction; repeating it here as "corporate" contradicted the
                banner it stands directly above. */}
            <p className="mt-1 text-sm text-muted-foreground">Войдите через Google</p>
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

        {/* task-user-emails-invite (spec §2): invite accepted, but "Токен НЕ
            выдаёт сессию" — this confirms the accept step worked, the person
            still clicks the Google button below to actually sign in. */}
        {invited && !error && (
          <motion.div
            className="mb-4 flex items-start gap-2.5 rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary"
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            data-testid="login-invite-accepted-message"
          >
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            {/* COPY-M-7 (copy-review PR #623 round 4): "войти им" read badly;
                "теперь вы можете" was three words of nothing. */}
            <span>Личный адрес подтверждён. Войдите через Google — выберите этот адрес.</span>
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
