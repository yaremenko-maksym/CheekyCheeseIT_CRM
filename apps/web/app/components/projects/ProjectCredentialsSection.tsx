/**
 * ProjectCredentialsSection — work-account passwords for a project.
 *
 * RBAC (server-enforced; component hides itself on 403):
 *   View + reveal: ADMIN, HR of the senior's team, active JUNIOR member.
 *   Edit (add/edit/delete): ADMIN, HR (prop `canEdit`). JUNIOR → reveal only.
 *   SENIOR / DROP / ACCOUNTANT → 403 → section hidden.
 *
 * SECURITY: the list NEVER contains plaintext. Reveal fetches plaintext on
 * demand and keeps it in LOCAL row state only (never in the query cache). The
 * revealed value auto-hides after 30s via a CSS timer bar.
 */
import { forwardRef, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Check,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import { useForm } from '@tanstack/react-form'
import { createCredentialSchema, type ProjectCredential } from '@crm/shared'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  useCreateCredential,
  useCredentials,
  useDeleteCredential,
  useRevealCredential,
  useUpdateCredential,
} from '@/hooks/use-credentials'
import { getAxiosStatus } from '@/lib/axios-utils'
import { cn } from '@/lib/utils'

interface ProjectCredentialsSectionProps {
  /** UUID проекта */
  projectId: string
  /**
   * Controls edit/delete button visibility (per-row ✏/🗑).
   * JUNIOR → false (reveal/copy only). ADMIN/HR → true.
   */
  canEdit: boolean
  /**
   * Controls the «+ Добавить» button independently of canEdit (task §6 round 2).
   * JUNIOR on their own project → true (create allowed, edit/delete not).
   * Defaults to `canEdit` for backwards compatibility (ADMIN/HR inherit).
   */
  canAdd?: boolean
  /**
   * Render credentials in a 2-column grid when >= 2 items (junior hub full-width).
   * Scoped to junior hub only — default false to avoid changing ADMIN/HR profile view.
   * task-junior-ut-round3 §2.5
   */
  twoColumn?: boolean
}

// Threshold (§9.2): wrap the list in a ScrollArea once it grows past this many rows.
const SCROLL_THRESHOLD = 8

export function ProjectCredentialsSection({
  projectId,
  canEdit,
  canAdd,
  twoColumn = false,
}: ProjectCredentialsSectionProps) {
  // «+ Добавить» shows for editors (ADMIN/HR) and for JUNIOR with explicit canAdd.
  const showAddButton = canEdit || (canAdd ?? false)
  const { data: credentials, isLoading, isError } = useCredentials(projectId)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ProjectCredential | null>(null)

  // 403 → hook returns null (data === null) → hide the section entirely.
  // isError covers non-403 hard failures; we also hide rather than show a broken card.
  if (!isLoading && (credentials === null || isError)) return null

  const openAdd = () => {
    setEditing(null)
    setDialogOpen(true)
  }

  const openEdit = (cred: ProjectCredential) => {
    setEditing(cred)
    setDialogOpen(true)
  }

  return (
    <Card data-testid="credentials-section" className="border-border/40">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <KeyRound className="h-3.5 w-3.5" />
          Пароли проекта
        </CardTitle>
        {showAddButton && (
          <Button
            variant="ghost"
            size="sm"
            onClick={openAdd}
            data-testid="credentials-add-btn"
            title="Добавить аккаунт проекта"
            className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
            Добавить
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full rounded-md" />
            <Skeleton className="h-12 w-full rounded-md" />
          </div>
        ) : !credentials || credentials.length === 0 ? (
          <p className="text-sm text-muted-foreground/60 italic">Нет сохранённых паролей</p>
        ) : (
          <CredentialList
            credentials={credentials}
            projectId={projectId}
            canEdit={canEdit}
            onEdit={openEdit}
            twoColumn={twoColumn}
          />
        )}
      </CardContent>

      {/* Unmount CredentialDialog when closed so form state resets on every open.
          Security: plaintext never lingers between sessions (task-junior-ut-round3 §4). */}
      {dialogOpen && (
        <CredentialDialog
          projectId={projectId}
          editing={editing}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
        />
      )}
    </Card>
  )
}

// ── List ──────────────────────────────────────────────────────────────────

function CredentialList({
  credentials,
  projectId,
  canEdit,
  onEdit,
  twoColumn,
}: {
  credentials: ProjectCredential[]
  projectId: string
  canEdit: boolean
  onEdit: (cred: ProjectCredential) => void
  twoColumn?: boolean
}) {
  // Two-column grid for >= 2 items when twoColumn prop is set (junior hub full-width).
  // Single item → 1-col (avoids rogue right-side gap on full-width strip).
  const useTwoCol = twoColumn && credentials.length >= 2

  const rows = (
    <TooltipProvider delayDuration={300}>
      <ul
        className={cn(useTwoCol ? 'grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1' : 'space-y-1')}
        data-testid="credentials-list"
      >
        {credentials.map((cred, i) => (
          <li key={cred.id}>
            {!useTwoCol && i > 0 && <Separator className="my-1" />}
            <CredentialRow
              credential={cred}
              projectId={projectId}
              canEdit={canEdit}
              onEdit={onEdit}
            />
          </li>
        ))}
      </ul>
    </TooltipProvider>
  )

  if (credentials.length > SCROLL_THRESHOLD) {
    return <ScrollArea className="max-h-[480px] pr-3">{rows}</ScrollArea>
  }
  return rows
}

// ── Row (owns reveal/copy/delete state per credential) ──────────────────────

function CredentialRow({
  credential,
  projectId,
  canEdit,
  onEdit,
}: {
  credential: ProjectCredential
  projectId: string
  canEdit: boolean
  onEdit: (cred: ProjectCredential) => void
}) {
  const reveal = useRevealCredential(projectId)
  const del = useDeleteCredential(projectId)

  // Plaintext lives ONLY here (component state) — never in the query cache.
  const [plaintext, setPlaintext] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [clipboardStatus, setClipboardStatus] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  // 429 cooldown — disable reveal for N seconds (§9.3).
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null)
  const [, forceTick] = useState(0)
  const revealBtnRef = useRef<HTMLButtonElement>(null)

  // Tick every second while in cooldown so the disabled countdown updates.
  useEffect(() => {
    if (cooldownUntil === null) return
    const id = window.setInterval(() => {
      forceTick((n) => n + 1)
      if (Date.now() >= cooldownUntil) setCooldownUntil(null)
    }, 1000)
    return () => window.clearInterval(id)
  }, [cooldownUntil])

  // Reset the "Copied" icon after 2s.
  useEffect(() => {
    if (!copied) return
    const id = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(id)
  }, [copied])

  // Clear the aria-live clipboard status after 3s so a repeat copy re-announces.
  useEffect(() => {
    if (!clipboardStatus) return
    const id = window.setTimeout(() => setClipboardStatus(''), 3000)
    return () => window.clearTimeout(id)
  }, [clipboardStatus])

  const cooldownSeconds =
    cooldownUntil !== null ? Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000)) : 0
  const revealDisabled = reveal.isPending || cooldownSeconds > 0

  const handleToggleReveal = async () => {
    // Second click while shown → hide.
    if (plaintext !== null) {
      setPlaintext(null)
      return
    }
    setError(null)
    try {
      const password = await reveal.mutateAsync(credential.id)
      setPlaintext(password)
    } catch (err: unknown) {
      const status = getAxiosStatus(err)
      if (status === 403) {
        setError('Нет доступа к этому паролю')
      } else if (status === 429) {
        setError('Слишком много запросов. Попробуйте через минуту.')
        setCooldownUntil(Date.now() + 60_000)
      } else {
        setError('Не удалось получить пароль. Попробуйте ещё раз.')
      }
    }
  }

  const handleCopy = async () => {
    if (plaintext === null) return
    try {
      // navigator.clipboard requires a secure context + permission; fall back
      // gracefully so the action never throws to the user.
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(plaintext)
      }
      setCopied(true)
      setClipboardStatus('Пароль скопирован')
    } catch {
      // Clipboard blocked — surface a soft inline error, keep plaintext visible.
      setError('Не удалось скопировать. Скопируйте вручную.')
    }
  }

  const handleAutoHide = () => {
    // CSS timer finished (30s) → clear plaintext (§7 / §9.5).
    setPlaintext(null)
  }

  const handleDelete = async () => {
    await del.mutateAsync(credential.id)
    setConfirmOpen(false)
  }

  const revealed = plaintext !== null

  return (
    <div className="py-1.5" data-testid={`credentials-item-${credential.id}`}>
      <div className="flex items-start gap-2">
        {/* Label + login + url (flex-1, truncates) */}
        <div className="flex-1 min-w-0">
          <p
            className="text-sm font-medium truncate"
            title={credential.label}
            data-testid={`credentials-label-${credential.id}`}
          >
            {credential.label}
          </p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {credential.login && (
              <span className="truncate max-w-[160px] sm:max-w-[240px]" title={credential.login}>
                {credential.login}
              </span>
            )}
            {credential.login && credential.url && <span aria-hidden>·</span>}
            {credential.url && (
              <a
                href={credential.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 truncate max-w-[120px] sm:max-w-[180px] hover:text-foreground transition-colors"
              >
                <span className="truncate">{stripProtocol(credential.url)}</span>
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            )}
          </div>
          {/* Static mask — NOT an input, never carries plaintext */}
          {!revealed && (
            <p className="text-sm text-muted-foreground/50 tracking-widest font-mono mt-0.5">
              ••••••••
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-0.5 shrink-0">
          <IconButton
            ref={revealBtnRef}
            testId={`credentials-reveal-btn-${credential.id}`}
            label={revealed ? 'Скрыть пароль' : 'Показать пароль'}
            ariaPressed={revealed}
            disabled={revealDisabled}
            title={cooldownSeconds > 0 ? `Доступно через ${cooldownSeconds}с` : undefined}
            onClick={() => void handleToggleReveal()}
          >
            {reveal.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : revealed ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </IconButton>

          {revealed && (
            <IconButton
              testId={`credentials-copy-btn-${credential.id}`}
              label={copied ? 'Скопировано' : 'Копировать пароль'}
              onClick={() => void handleCopy()}
            >
              {copied ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
            </IconButton>
          )}

          {canEdit && (
            <>
              <IconButton
                testId={`credentials-edit-btn-${credential.id}`}
                label="Редактировать"
                onClick={() => onEdit(credential)}
              >
                <Pencil className="h-4 w-4" />
              </IconButton>
              <IconButton
                testId={`credentials-delete-btn-${credential.id}`}
                label="Удалить"
                onClick={() => setConfirmOpen(true)}
              >
                <Trash2 className="h-4 w-4" />
              </IconButton>
            </>
          )}
        </div>
      </div>

      {/* Reveal block — concentric "safe" box with countdown bar */}
      <AnimatePresence>
        {revealed && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0, transition: { duration: 0.15 } }}
            transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-2 bg-muted/40 rounded-[calc(var(--radius)-4px)] px-3 py-2">
              <span
                className="font-mono text-sm font-medium tabular-nums tracking-[0.12em] text-foreground select-text break-all"
                data-testid={`credentials-password-display-${credential.id}`}
              >
                {plaintext}
              </span>
              <div className="mt-1.5 h-0.5 w-full bg-primary/30 rounded-full overflow-hidden">
                <div
                  className="credentials-timer-bar h-full bg-primary/60"
                  data-testid={`credentials-timer-bar-${credential.id}`}
                  onAnimationEnd={handleAutoHide}
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Inline error (403 / 429 / network) */}
      {error && (
        <p
          className="text-xs text-destructive mt-1"
          data-testid={`credentials-error-${credential.id}`}
        >
          {error}
        </p>
      )}

      {/* aria-live status for clipboard (SC 4.1.3) */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-testid="credentials-clipboard-status"
      >
        {clipboardStatus}
      </div>

      {/* Delete confirm */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid="credentials-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить аккаунт?</AlertDialogTitle>
            <AlertDialogDescription>
              Запись «{credential.label}» будет удалена безвозвратно.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                void handleDelete()
              }}
              disabled={del.isPending}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {del.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ── Add / Edit dialog ───────────────────────────────────────────────────────

function CredentialDialog({
  projectId,
  editing,
  open,
  onOpenChange,
}: {
  projectId: string
  editing: ProjectCredential | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const create = useCreateCredential(projectId)
  const update = useUpdateCredential(projectId)
  const [showPassword, setShowPassword] = useState(false)
  const isEdit = editing !== null

  const form = useForm({
    defaultValues: {
      label: editing?.label ?? '',
      login: editing?.login ?? '',
      password: '',
      url: editing?.url ?? '',
      notes: editing?.notes ?? '',
    },
    onSubmit: async ({ value }) => {
      if (isEdit) {
        await update.mutateAsync({
          id: editing.id,
          data: {
            label: value.label,
            login: value.login || null,
            // Empty password → backend keeps the stored one.
            ...(value.password ? { password: value.password } : {}),
            url: value.url || null,
            notes: value.notes || null,
          },
        })
      } else {
        const dto = createCredentialSchema.parse({
          label: value.label,
          login: value.login || null,
          password: value.password,
          url: value.url || null,
          notes: value.notes || null,
        })
        await create.mutateAsync(dto)
      }
      onOpenChange(false)
    },
  })

  const pending = create.isPending || update.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="credentials-dialog">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Редактировать аккаунт' : 'Добавить аккаунт'}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            e.stopPropagation()
            void form.handleSubmit()
          }}
          className="space-y-4"
        >
          <form.Field name="label">
            {(field) => (
              <div className="space-y-1">
                <Label htmlFor="credentials-label">Название *</Label>
                <Input
                  id="credentials-label"
                  data-testid="credentials-input-label"
                  autoFocus
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="GitHub, Jira, Slack..."
                />
              </div>
            )}
          </form.Field>

          <form.Field name="login">
            {(field) => (
              <div className="space-y-1">
                <Label htmlFor="credentials-login">Логин</Label>
                <Input
                  id="credentials-login"
                  data-testid="credentials-input-login"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="john.doe@company.com"
                  autoCapitalize="off"
                  autoCorrect="off"
                />
              </div>
            )}
          </form.Field>

          <form.Field name="password">
            {(field) => (
              <div className="space-y-1">
                <Label htmlFor="credentials-password">{isEdit ? 'Новый пароль' : 'Пароль *'}</Label>
                <div className="relative">
                  <Input
                    id="credentials-password"
                    data-testid="credentials-input-password"
                    type={showPassword ? 'text' : 'password'}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder={isEdit ? 'Оставьте пустым, чтобы не менять' : 'Пароль аккаунта'}
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            )}
          </form.Field>

          <form.Field name="url">
            {(field) => (
              <div className="space-y-1">
                <Label htmlFor="credentials-url">URL</Label>
                <Input
                  id="credentials-url"
                  data-testid="credentials-input-url"
                  type="url"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="https://github.com"
                />
              </div>
            )}
          </form.Field>

          <form.Field name="notes">
            {(field) => (
              <div className="space-y-1">
                <Label htmlFor="credentials-notes">Заметки</Label>
                <Textarea
                  id="credentials-notes"
                  data-testid="credentials-input-notes"
                  rows={3}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="Дополнительная информация..."
                />
              </div>
            )}
          </form.Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={pending} data-testid="credentials-dialog-submit">
              {pending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Сохранить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── Shared icon-button with tooltip ─────────────────────────────────────────

const IconButton = forwardRef<
  HTMLButtonElement,
  {
    testId: string
    label: string
    // `| undefined` explicit so callers can pass conditional `title={... : undefined}`
    // under exactOptionalPropertyTypes (project tsconfig gotcha).
    ariaPressed?: boolean | undefined
    disabled?: boolean | undefined
    title?: string | undefined
    onClick: () => void
    children: React.ReactNode
  }
>(function IconButton({ testId, label, ariaPressed, disabled, title, onClick, children }, ref) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={ref}
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-1.5 text-muted-foreground hover:text-foreground"
          aria-label={label}
          aria-pressed={ariaPressed}
          aria-disabled={disabled || undefined}
          disabled={disabled}
          title={title}
          data-testid={testId}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
})

// ── helpers ─────────────────────────────────────────────────────────────────

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//, '')
}
