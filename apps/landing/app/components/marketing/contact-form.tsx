import { useId, useRef, useState, type FormEvent } from 'react'
import { Check, Mail, ShieldCheck } from 'lucide-react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { submitContact, type SubmitContactErrorKind } from '@/lib/api'
import { useTurnstile } from '@/lib/use-turnstile'
import { CONTACT_EMAIL } from '@/content/home'
import type { Dictionary } from '@/i18n/dictionary'

/**
 * Contact form (task-landing-contact-and-hiring-strip.md — owner decision §1:
 * "Открывается форма прямо на странице"). Built by the SAME recipe as
 * `VacancyApplyForm` — Turnstile + honeypot + a client-side Zod mirror of the
 * server contract (`contactRequestSchema`, `packages/shared/src/schemas/
 * contact.ts`) + a 3-state machine (idle/submitting → success | error) — not
 * a separate pattern. Rendered inline in the `#contact` section
 * (`home-page-content.tsx`), not in a modal/Sheet: the landing has no Sheet/
 * Dialog primitive (`apps/web`'s `sheet.tsx` depends on `@radix-ui/react-
 * dialog`, not installed here — see this task's PR body for the full
 * rationale), and the existing `#contact` section is already the single,
 * always-reachable landing spot every "Start a project" CTA across the site
 * scrolls to (`hashLinkProps('contact', …)`, `nav.tsx`/`footer.tsx`) — an
 * inline form there satisfies the owner decision literally without a new
 * frontend dependency.
 *
 * Owner decision §4: `CONTACT_EMAIL` (`content/home.ts`, already
 * `hr@cheekycheese.tech`) stays visible as a `mailto:` fallback link right
 * under the submit button — the ONLY `mailto:` left in a CTA context
 * (task AC1).
 *
 * review round 1 MED-2 — `errorKind: 'turnstile'` (server 422, a captcha-
 * check failure) is handled SEPARATELY from every other error kind here,
 * not through `API_ERROR_MESSAGE_KEYS`: the fields are fine, only the
 * anti-bot check needs a retry, so it gets its own copy + its own repeat-
 * failure escalation (see `turnstileFailureStreak` below) instead of the
 * generic "check your details" validation message.
 */
const API_ERROR_MESSAGE_KEYS: Record<
  Exclude<SubmitContactErrorKind, 'turnstile'>,
  keyof Dictionary['home']['contactForm']
> = {
  validation: 'apiErrorValidation',
  'rate-limited': 'apiErrorRateLimited',
  unavailable: 'apiErrorUnavailable',
  network: 'apiErrorNetwork',
}

type FormStatus = 'idle' | 'submitting' | 'success' | 'error'

/** Client-side mirror of `contactRequestSchema` (server owns the source of truth). */
const clientFieldsSchema = z.object({
  name: z.string().min(2).max(80),
  company: z.string().max(120).optional(),
  email: z.email().max(160),
  message: z.string().min(10).max(2000),
})

interface FieldErrors {
  name?: string
  email?: string
  message?: string
}

export function ContactForm({ dict }: { dict: Dictionary }) {
  const t = dict.home.contactForm
  const [status, setStatus] = useState<FormStatus>('idle')
  const [name, setName] = useState('')
  const [company, setCompany] = useState('')
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [website, setWebsite] = useState('') // honeypot — must stay empty
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [bannerMessage, setBannerMessage] = useState<string | null>(null)
  // review round 1 MED-2 — how many Turnstile (422) failures in a row THIS
  // submit streak has seen. Any OTHER error kind (or a successful submit)
  // resets it: the escalation is specifically about "the captcha check keeps
  // failing", not a running total across the whole session.
  const [turnstileFailureStreak, setTurnstileFailureStreak] = useState(0)

  const clearFieldError = (key: keyof FieldErrors) => {
    setFieldErrors((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const {
    containerRef: turnstileRef,
    token: turnstileToken,
    reset: resetTurnstile,
  } = useTurnstile()

  // design round 1 LOW-1 — refs so a failed CLIENT-side validation can move
  // real DOM focus to the first invalid field (see `handleSubmit`), same
  // principle `VacancyTranslationFields` (apps/web) uses for its own
  // submit-error handling: an `aria-invalid`/`aria-describedby` association
  // alone only announces once the user tabs there THEMSELVES — silent if
  // focus is left on the submit button, which is exactly what was
  // happening here before.
  const nameFieldRef = useRef<HTMLInputElement>(null)
  const emailFieldRef = useRef<HTMLInputElement>(null)
  const messageFieldRef = useRef<HTMLTextAreaElement>(null)

  const nameId = useId()
  const companyId = useId()
  const emailId = useId()
  const messageId = useId()
  const websiteId = useId()
  const nameErrorId = useId()
  const emailErrorId = useId()
  const messageErrorId = useId()

  if (status === 'success') {
    return (
      <Card className="px-6 pt-5 pb-6 text-center md:px-6" role="status">
        <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-full bg-primary/16 text-primary shadow-[0_0_40px_-8px_var(--marketing-glow)]">
          <Check aria-hidden="true" className="size-[30px]" />
        </div>
        <h2 className="mb-2.5 text-[1.4rem] font-semibold tracking-[-0.015em] text-foreground">
          {t.successHeading}
        </h2>
        <p className="mx-auto max-w-[38ch] text-muted-foreground">{t.successBody}</p>
      </Card>
    )
  }

  const validateFields = (): FieldErrors => {
    const errors: FieldErrors = {}
    const result = clientFieldsSchema.safeParse({
      name,
      company: company || undefined,
      email,
      message,
    })
    if (!result.success) {
      for (const issue of result.error.issues) {
        const path = issue.path[0]
        if (path === 'name') errors.name = t.errorName
        else if (path === 'email') errors.email = t.errorEmail
        else if (path === 'message') errors.message = t.errorMessage
      }
    }
    return errors
  }

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (status === 'submitting') return

    const errors = validateFields()
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors)
      // design round 1 LOW-1 — focus the FIRST invalid field, in visual/DOM
      // order (name → email → message), instead of leaving focus on the
      // submit button. `aria-invalid`/`aria-describedby` (already wired on
      // every field below) then makes the screen reader announce BOTH
      // "invalid" and the message text immediately, since focus itself
      // just moved there.
      if (errors.name) nameFieldRef.current?.focus()
      else if (errors.email) emailFieldRef.current?.focus()
      else if (errors.message) messageFieldRef.current?.focus()
      return
    }

    setFieldErrors({})
    setBannerMessage(null)
    setStatus('submitting')

    const trimmedCompany = company.trim()
    const result = await submitContact({
      name: name.trim(),
      // `exactOptionalPropertyTypes` — omit the key entirely rather than
      // assign `company: undefined` (same pattern as VacancyApplyForm's
      // `telegram`/`linkedinUrl`/... optional fields).
      ...(trimmedCompany ? { company: trimmedCompany } : {}),
      email: email.trim(),
      message: message.trim(),
      turnstileToken: turnstileToken ?? '',
      website,
    })

    if (result.ok) {
      setStatus('success')
      return
    }

    setStatus('error')
    if (result.errorKind === 'turnstile') {
      // 1st failure in a streak → plain retry copy; 2nd+ consecutive
      // failure → the SAME copy plus an inline `hr@` link right at the
      // point of failure (the persistent link under the button, below,
      // stays regardless — this is an EXTRA, more visible nudge once a
      // retry has already failed once).
      const nextStreak = turnstileFailureStreak + 1
      setTurnstileFailureStreak(nextStreak)
      setBannerMessage(nextStreak >= 2 ? t.apiErrorTurnstileRepeat : t.apiErrorTurnstile)
    } else {
      setTurnstileFailureStreak(0)
      const messageKey = result.errorKind
        ? API_ERROR_MESSAGE_KEYS[result.errorKind]
        : 'apiErrorValidation'
      setBannerMessage(t[messageKey])
    }
    resetTurnstile()
  }

  // Inline `hr@` link — ONLY alongside the repeat-Turnstile-failure banner
  // (see `handleSubmit`'s `apiErrorTurnstileRepeat` branch); every other
  // error banner relies on the persistent link below the button instead.
  const showInlineTurnstileRetryLink =
    status === 'error' && bannerMessage === t.apiErrorTurnstileRepeat

  return (
    <Card className="p-7 text-left md:p-7">
      {status === 'error' && bannerMessage && (
        <div
          role="alert"
          className="mb-5 flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/12 p-3.5 text-[0.92rem] text-destructive"
        >
          <span>
            {bannerMessage}
            {showInlineTurnstileRetryLink && (
              <>
                {' '}
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="font-medium underline underline-offset-2"
                >
                  {CONTACT_EMAIL}
                </a>
              </>
            )}
          </span>
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-[18px]">
        <div className="grid grid-cols-1 gap-[18px] min-[560px]:grid-cols-2">
          <div>
            <label
              htmlFor={nameId}
              className="mb-2 block text-[0.9rem] font-medium text-foreground/88"
            >
              {t.nameLabel}
              <span aria-hidden="true" className="ml-0.5 text-primary">
                *
              </span>
            </label>
            <Input
              ref={nameFieldRef}
              id={nameId}
              name="name"
              placeholder={t.namePlaceholder}
              required
              value={name}
              aria-invalid={fieldErrors.name ? true : undefined}
              aria-describedby={fieldErrors.name ? nameErrorId : undefined}
              onChange={(e) => {
                setName(e.target.value)
                clearFieldError('name')
              }}
            />
            {fieldErrors.name && (
              <div id={nameErrorId} className="mt-1.5 text-[0.8rem] text-destructive">
                {fieldErrors.name}
              </div>
            )}
          </div>
          <div>
            <label
              htmlFor={companyId}
              className="mb-2 block text-[0.9rem] font-medium text-foreground/88"
            >
              {t.companyLabel}
            </label>
            <Input
              id={companyId}
              name="company"
              placeholder={t.companyPlaceholder}
              value={company}
              onChange={(e) => setCompany(e.target.value)}
            />
          </div>
        </div>

        <div>
          <label
            htmlFor={emailId}
            className="mb-2 block text-[0.9rem] font-medium text-foreground/88"
          >
            {t.emailLabel}
            <span aria-hidden="true" className="ml-0.5 text-primary">
              *
            </span>
          </label>
          <Input
            ref={emailFieldRef}
            id={emailId}
            name="email"
            type="email"
            placeholder={t.emailPlaceholder}
            required
            value={email}
            aria-invalid={fieldErrors.email ? true : undefined}
            aria-describedby={fieldErrors.email ? emailErrorId : undefined}
            onChange={(e) => {
              setEmail(e.target.value)
              clearFieldError('email')
            }}
          />
          {fieldErrors.email && (
            <div id={emailErrorId} className="mt-1.5 text-[0.8rem] text-destructive">
              {fieldErrors.email}
            </div>
          )}
        </div>

        <div>
          <label
            htmlFor={messageId}
            className="mb-2 block text-[0.9rem] font-medium text-foreground/88"
          >
            {t.messageLabel}
            <span aria-hidden="true" className="ml-0.5 text-primary">
              *
            </span>
          </label>
          <Textarea
            ref={messageFieldRef}
            id={messageId}
            name="message"
            placeholder={t.messagePlaceholder}
            required
            value={message}
            aria-invalid={fieldErrors.message ? true : undefined}
            aria-describedby={fieldErrors.message ? messageErrorId : undefined}
            onChange={(e) => {
              setMessage(e.target.value)
              clearFieldError('message')
            }}
          />
          {fieldErrors.message && (
            <div id={messageErrorId} className="mt-1.5 text-[0.8rem] text-destructive">
              {fieldErrors.message}
            </div>
          )}
        </div>

        {/* Honeypot — visually hidden via display:none on purpose, same
            pattern as VacancyApplyForm: human assistive tech should never
            reach it, unlike a normal hidden field. `name="website"` is
            deliberately left in English (a decoy field name bots look for,
            not user-facing copy) — `id`/`htmlFor` use `useId()` instead of a
            literal string so they never collide with any other form on the
            same document. */}
        <div style={{ display: 'none' }} aria-hidden="true">
          <label htmlFor={websiteId}>Website</label>
          <input
            id={websiteId}
            name="website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </div>

        {/* Turnstile renders into this container (invisible/managed mode —
            see useTurnstile). Constrained + clipped so its fixed-width
            injected markup can't force horizontal overflow on narrow
            viewports (same fix as VacancyApplyForm, PR #393). */}
        <div ref={turnstileRef} className="max-w-full overflow-hidden" />

        <Button type="submit" block aria-disabled={status === 'submitting'} className="mt-1">
          {status === 'submitting' ? (
            <span className="inline-flex items-center gap-2.5">
              <span
                aria-hidden="true"
                className="size-[15px] animate-spin rounded-full border-2 border-primary-foreground/40 border-t-primary-foreground"
              />
              {t.submitting}
            </span>
          ) : (
            <span>{t.submit}</span>
          )}
        </Button>

        <div className="mt-0.5 flex flex-col items-center justify-center gap-2 text-center text-[0.78rem] text-muted-foreground">
          <div className="flex items-center gap-2">
            <ShieldCheck aria-hidden="true" className="size-3.5" />
            {t.protectedBy}
          </div>
          <div>
            {t.orEmailUs}{' '}
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"
            >
              <Mail aria-hidden="true" className="size-3.5" />
              {CONTACT_EMAIL}
            </a>
          </div>
        </div>
      </form>
    </Card>
  )
}
