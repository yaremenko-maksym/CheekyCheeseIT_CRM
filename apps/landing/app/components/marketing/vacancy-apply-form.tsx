import { useId, useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { Check, ShieldCheck } from 'lucide-react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { CvDropzone } from '@/components/marketing/cv-dropzone'
import { submitApplication } from '@/lib/api'
import { useTurnstile } from '@/lib/use-turnstile'
import { cn } from '@/lib/utils'

/**
 * Vacancy apply form (landing-redesign.md §2.4 `VacancyApplyForm`,
 * Vacancy.dc.html aside). Controlled, 4 states (default/submitting/success/
 * error — task-landing-redesign.md AC4), Turnstile + honeypot + client
 * validation mirroring `applyVacancyFieldsSchema` server rules.
 */

type FormStatus = 'idle' | 'submitting' | 'success' | 'error'

/** Client-side mirror of `applyVacancyFieldsSchema` (server owns the source of truth). */
const clientFieldsSchema = z.object({
  fullName: z.string().min(2).max(120),
  email: z.email().max(254),
  telegram: z.string().max(120).optional(),
  linkedinUrl: z.url().startsWith('https://').max(300).optional(),
  githubUrl: z.url().startsWith('https://').max(300).optional(),
  coverLetter: z.string().max(2000).optional(),
})

interface FieldErrors {
  fullName?: string
  email?: string
  linkedinUrl?: string
  githubUrl?: string
}

export function VacancyApplyForm({ slug, vacancyTitle }: { slug: string; vacancyTitle: string }) {
  const [status, setStatus] = useState<FormStatus>('idle')
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [telegram, setTelegram] = useState('')
  const [linkedinUrl, setLinkedinUrl] = useState('')
  const [githubUrl, setGithubUrl] = useState('')
  const [coverLetter, setCoverLetter] = useState('')
  const [website, setWebsite] = useState('') // honeypot — must stay empty
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [bannerMessage, setBannerMessage] = useState<string | null>(null)

  // `exactOptionalPropertyTypes` forbids `{ ...prev, key: undefined }` (the
  // key must be ABSENT, not present-with-undefined) — clear via omission.
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

  const nameId = useId()
  const emailId = useId()
  const telegramId = useId()
  const linkedinId = useId()
  const githubId = useId()
  const coverId = useId()
  const nameErrorId = useId()
  const emailErrorId = useId()
  const linkedinErrorId = useId()
  const githubErrorId = useId()

  if (status === 'success') {
    const firstName = fullName.trim().split(' ')[0]
    return (
      <Card className="px-6 pt-5 pb-3 text-center md:px-6" role="status">
        <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-full bg-primary/16 text-primary shadow-[0_0_40px_-8px_var(--marketing-glow)]">
          <Check aria-hidden="true" className="size-[30px]" />
        </div>
        <h2 className="mb-2.5 text-[1.4rem] font-semibold tracking-[-0.015em] text-foreground">
          Application received
        </h2>
        <p className="mx-auto mb-6 max-w-[34ch] text-muted-foreground">
          Thanks{firstName ? `, ${firstName}` : ''} — we&rsquo;ve got your application for{' '}
          <strong className="text-foreground">{vacancyTitle}</strong>. We review every one and reply
          within a few business days.
        </p>
        <Button asChild variant="outline">
          <Link to="/careers">Browse more roles</Link>
        </Button>
      </Card>
    )
  }

  const validateFields = (): FieldErrors => {
    const errors: FieldErrors = {}
    const result = clientFieldsSchema.safeParse({
      fullName,
      email,
      telegram: telegram || undefined,
      linkedinUrl: linkedinUrl || undefined,
      githubUrl: githubUrl || undefined,
      coverLetter: coverLetter || undefined,
    })
    if (!result.success) {
      for (const issue of result.error.issues) {
        const path = issue.path[0]
        if (path === 'fullName') errors.fullName = 'Please enter your name.'
        else if (path === 'email') errors.email = 'Enter a valid email.'
        else if (path === 'linkedinUrl')
          errors.linkedinUrl = 'Enter a valid LinkedIn URL (https://…).'
        else if (path === 'githubUrl') errors.githubUrl = 'Enter a valid GitHub URL (https://…).'
      }
    }
    return errors
  }

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (status === 'submitting') return

    const errors = validateFields()
    const missingFile = !file
    if (missingFile) setFileError((prev) => prev ?? 'Please attach your CV (PDF).')
    if (Object.keys(errors).length > 0 || missingFile || fileError) {
      setFieldErrors(errors)
      return
    }

    setFieldErrors({})
    setBannerMessage(null)
    setStatus('submitting')

    const formData = new FormData()
    formData.set('fullName', fullName.trim())
    formData.set('email', email.trim())
    if (telegram) formData.set('telegram', telegram.trim())
    if (linkedinUrl) formData.set('linkedinUrl', linkedinUrl.trim())
    if (githubUrl) formData.set('githubUrl', githubUrl.trim())
    if (coverLetter) formData.set('coverLetter', coverLetter.trim())
    formData.set('turnstileToken', turnstileToken ?? '')
    formData.set('website', website) // honeypot — empty unless a bot filled it
    formData.set('resume', file as File)

    const result = await submitApplication(slug, formData)
    if (result.ok) {
      setStatus('success')
      return
    }

    setStatus('error')
    setBannerMessage(result.message ?? 'Something went wrong. Please try again.')
    resetTurnstile()
  }

  return (
    <Card className="p-7 md:p-7">
      <h2 className="mb-1.5 text-[1.3rem] font-semibold tracking-[-0.015em] text-foreground">
        Apply for this role
      </h2>
      <p className="mb-[22px] text-[0.9rem] text-muted-foreground">
        Takes about 3 minutes. Fields marked <span className="text-primary">*</span> are required.
      </p>

      {status === 'error' && bannerMessage && (
        <div
          role="alert"
          className="mb-5 flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/12 p-3.5 text-[0.92rem] text-destructive"
        >
          <span>{bannerMessage}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-[18px]">
        <div className="grid grid-cols-1 gap-[18px] min-[560px]:grid-cols-2">
          <div>
            <label
              htmlFor={nameId}
              className="mb-2 block text-[0.9rem] font-medium text-foreground/88"
            >
              Full name
              <span aria-hidden="true" className="ml-0.5 text-primary">
                *
              </span>
            </label>
            <Input
              id={nameId}
              name="name"
              placeholder="Ada Lovelace"
              required
              value={fullName}
              aria-invalid={fieldErrors.fullName ? true : undefined}
              aria-describedby={fieldErrors.fullName ? nameErrorId : undefined}
              onChange={(e) => {
                setFullName(e.target.value)
                clearFieldError('fullName')
              }}
            />
            {fieldErrors.fullName && (
              <div id={nameErrorId} className="mt-1.5 text-[0.8rem] text-destructive">
                {fieldErrors.fullName}
              </div>
            )}
          </div>
          <div>
            <label
              htmlFor={emailId}
              className="mb-2 block text-[0.9rem] font-medium text-foreground/88"
            >
              Email
              <span aria-hidden="true" className="ml-0.5 text-primary">
                *
              </span>
            </label>
            <Input
              id={emailId}
              name="email"
              type="email"
              placeholder="you@domain.com"
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
        </div>

        <div className="grid grid-cols-1 gap-[18px] min-[560px]:grid-cols-2">
          <div>
            <label
              htmlFor={telegramId}
              className="mb-2 block text-[0.9rem] font-medium text-foreground/88"
            >
              Telegram
            </label>
            <Input
              id={telegramId}
              name="telegram"
              placeholder="@handle"
              value={telegram}
              onChange={(e) => setTelegram(e.target.value)}
            />
          </div>
          <div>
            <label
              htmlFor={linkedinId}
              className="mb-2 block text-[0.9rem] font-medium text-foreground/88"
            >
              LinkedIn URL
            </label>
            <Input
              id={linkedinId}
              name="linkedin"
              type="url"
              placeholder="linkedin.com/in/…"
              value={linkedinUrl}
              aria-invalid={fieldErrors.linkedinUrl ? true : undefined}
              aria-describedby={fieldErrors.linkedinUrl ? linkedinErrorId : undefined}
              onChange={(e) => {
                setLinkedinUrl(e.target.value)
                clearFieldError('linkedinUrl')
              }}
            />
            {fieldErrors.linkedinUrl && (
              <div id={linkedinErrorId} className="mt-1.5 text-[0.8rem] text-destructive">
                {fieldErrors.linkedinUrl}
              </div>
            )}
          </div>
        </div>

        <div>
          <label
            htmlFor={githubId}
            className="mb-2 block text-[0.9rem] font-medium text-foreground/88"
          >
            GitHub URL
          </label>
          <Input
            id={githubId}
            name="github"
            type="url"
            placeholder="github.com/…"
            value={githubUrl}
            aria-invalid={fieldErrors.githubUrl ? true : undefined}
            aria-describedby={fieldErrors.githubUrl ? githubErrorId : undefined}
            onChange={(e) => {
              setGithubUrl(e.target.value)
              clearFieldError('githubUrl')
            }}
          />
          {fieldErrors.githubUrl && (
            <div id={githubErrorId} className="mt-1.5 text-[0.8rem] text-destructive">
              {fieldErrors.githubUrl}
            </div>
          )}
        </div>

        <div>
          <label
            htmlFor={coverId}
            className="mb-2 block text-[0.9rem] font-medium text-foreground/88"
          >
            Cover letter
          </label>
          <Textarea
            id={coverId}
            name="cover"
            placeholder="Tell us about something hard you shipped and what you'd want to build here."
            value={coverLetter}
            onChange={(e) => setCoverLetter(e.target.value)}
          />
        </div>

        <CvDropzone
          file={file}
          onFileChange={setFile}
          error={fileError}
          onErrorChange={setFileError}
        />

        {/* Honeypot — visually hidden via display:none on purpose (§9): human
            assistive tech should never reach it, unlike a normal hidden field. */}
        <div style={{ display: 'none' }} aria-hidden="true">
          <label htmlFor="website">Website</label>
          <input
            id="website"
            name="website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </div>

        {/* Turnstile renders into this container (invisible/managed mode — see useTurnstile). */}
        <div ref={turnstileRef} />

        <Button type="submit" block aria-disabled={status === 'submitting'} className="mt-1">
          {status === 'submitting' ? (
            <span className="inline-flex items-center gap-2.5">
              <span
                aria-hidden="true"
                className="size-[15px] animate-spin rounded-full border-2 border-primary-foreground/40 border-t-primary-foreground"
              />
              Sending…
            </span>
          ) : (
            <span>Submit application</span>
          )}
        </Button>

        <div
          className={cn(
            'mt-0.5 flex items-center justify-center gap-2 text-[0.78rem] text-muted-foreground',
          )}
        >
          <ShieldCheck aria-hidden="true" className="size-3.5" />
          Protected by invisible captcha — no puzzles, ever.
        </div>
      </form>
    </Card>
  )
}
