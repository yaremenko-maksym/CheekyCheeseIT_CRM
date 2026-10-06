import type { ReactFormExtendedApi } from '@tanstack/react-form'
import { Trans, useLingui } from '@lingui/react/macro'
import { z } from 'zod'
import type { Locale, UserProfileDto } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ROLE_LABEL_MESSAGES } from '@/components/ui/role-select'
import { translateZodCode, translateZodMessage } from '@/lib/axios-utils'
import { cn } from '@/lib/utils'
import {
  CREATE_ALLOWED_ROLES,
  ROLE_VARIANT,
  ROLES,
  type CreateAllowedRole,
  type Role,
} from '../constants'
import { Field, Section } from '../section'

// TanStack Form render props require many generics — same suppression as
// ContactsSection (the form instance is owned by UserDialog).
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyForm = ReactFormExtendedApi<any, any, any, any, any, any, any, any, any, any, any, any>
/* eslint-enable @typescript-eslint/no-explicit-any */

interface IdentitySectionProps {
  form: Pick<AnyForm, 'Field'>
  isCreate: boolean
  isEdit: boolean
  editingUser: Pick<UserProfileDto, 'id'> | null
  hrOnly: boolean
  /** RBAC flag (ut-11) computed by the parent — passed through verbatim. */
  isSelfAdminEdit: boolean
  originalEmail: string
  /**
   * ut-9: called with the trimmed new email when an Edit-mode admin commits a
   * changed, non-empty address. The parent owns the warning state + dialog.
   */
  onEmailChangeIntent: (email: string) => void
}

/**
 * Identity section of UserDialog: email, personal email (create), display name,
 * role and interface language. Pure move out of UserDialog — behavior and RBAC
 * conditions unchanged; the email-warning state stays in the parent.
 */
export function IdentitySection({
  form,
  isCreate,
  isEdit,
  editingUser,
  hrOnly,
  isSelfAdminEdit,
  originalEmail,
  onEmailChangeIntent,
}: IdentitySectionProps) {
  const { t, i18n } = useLingui()
  return (
    <Section title={t`Основне`}>
      <form.Field
        name="email"
        validators={{
          onBlur: ({ value, fieldApi }) => {
            // ut-8: skip validation if the field was never touched. The
            // dialog opens with an empty email in Create; clicking
            // anywhere outside the empty input shouldn't ignite the
            // "Invalid email" hint.
            if (!fieldApi.state.meta.isDirty) return undefined
            // Stryker disable next-line MethodExpression: the email input is type="email", whose HTML value-sanitization algorithm already strips leading/trailing whitespace before any typed value reaches the form state (WHATWG HTML §4.10.5.1.4, verified in jsdom), so dropping `.trim()` is unobservable through the UI
            const trimmed = value.trim()
            if (!trimmed) return translateZodCode('EMAIL_REQUIRED')
            const r = z.string().email('zod.EMAIL_INVALID').safeParse(trimmed)
            // Stryker disable next-line OptionalChaining: issues[0] is guaranteed non-null on a failed safeParse — see this file's other field validators for the same invariant
            return r.success ? undefined : translateZodMessage(r.error.issues[0]?.message)
          },
        }}
      >
        {(field) => {
          // ut-8: hide error until the field has been edited at least
          // once. `isDirty` flips after the first change — pure focus
          // + blur (no value change) keeps the error suppressed.
          // Stryker disable next-line ConditionalExpression,LogicalOperator: unobservable — the only validators are onBlur, so `errors[0]` can exist only after a blur (isTouched) and the validator itself bails on !isDirty; the gate cannot change what is rendered
          const showError = field.state.meta.isTouched && field.state.meta.isDirty
          const err = showError ? field.state.meta.errors[0] : undefined
          return (
            <Field label="Email" error={err} required>
              <Input
                type="email"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="user@cheekycheese.dev"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={() => {
                  field.handleBlur()
                  // ut-9: in Edit mode, surface the warning dialog
                  // once the admin commits an email that differs from
                  // the original (and is non-empty + valid email).
                  if (
                    isEdit &&
                    editingUser &&
                    // Stryker disable next-line MethodExpression: the email input is type="email", whose HTML value-sanitization algorithm already strips leading/trailing whitespace before any typed value reaches the form state (WHATWG HTML §4.10.5.1.4, verified in jsdom), so dropping `.trim()` is unobservable through the UI
                    field.state.value.trim() !== originalEmail &&
                    // Stryker disable next-line MethodExpression: the email input is type="email", whose HTML value-sanitization algorithm already strips leading/trailing whitespace before any typed value reaches the form state (WHATWG HTML §4.10.5.1.4, verified in jsdom), so dropping `.trim()` is unobservable through the UI
                    field.state.value.trim().length > 0
                  ) {
                    // Stryker disable next-line MethodExpression: the email input is type="email", whose HTML value-sanitization algorithm already strips leading/trailing whitespace before any typed value reaches the form state (WHATWG HTML §4.10.5.1.4, verified in jsdom), so dropping `.trim()` is unobservable through the UI
                    onEmailChangeIntent(field.state.value.trim())
                  }
                }}
                className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                autoComplete="off"
                data-testid="user-dialog-email"
              />
            </Field>
          )
        }}
      </form.Field>

      {/* §4.4 — personal address, ADMIN-entered at creation only.
          Not a login method until an invite is accepted (separate
          task) — the label says so, so the admin doesn't read this
          as "second working login" by mistake. */}
      {isCreate && (
        <form.Field
          name="personalEmail"
          validators={{
            // No `!isDirty` early-return here (unlike the `email` /
            // `displayName` fields above, which need one — see their
            // ut-8 comments): THIS field's defaultValue is always ''
            // (create-only, decision 7 — never pre-filled from an
            // edit-mode value the way `email` can be), so "untouched"
            // and "trimmed value is empty" are the exact same state.
            // The `!trimmed` check two lines down already covers it —
            // a separate dirty-gate here would be unreachable-distinct
            // complexity, not a second real guard (mutation-gate
            // closure, PR #623: three survived mutants at a guard that
            // provably cannot change behavior for THIS field).
            onBlur: ({ value, fieldApi }) => {
              // `.trim()` here (and on `getFieldValue('email')`
              // below) is defensive-only, same reasoning as the
              // submit payload builder above: both source inputs
              // are `type="email"`, whose HTML value-sanitization
              // algorithm already strips leading/trailing
              // whitespace before any typed value reaches this
              // code — verified empirically in jsdom, and it is
              // spec behavior (WHATWG HTML §4.10.5.1.4), not a
              // jsdom-only quirk.
              // Stryker disable next-line MethodExpression: unreachable via any typed input on a type="email" field — see the paragraph above
              const trimmed = value.trim()
              if (!trimmed) return undefined
              const r = z.string().email('zod.EMAIL_INVALID').safeParse(trimmed)
              // zod's SafeParseError.error.issues is never empty on a
              // failed parse (verified: packages/shared, `zod`'s own
              // contract) — `issues[0]` cannot be undefined here.
              // Stryker disable next-line OptionalChaining: issues[0] is guaranteed non-null on a failed safeParse — see the comment above
              if (!r.success) return translateZodMessage(r.error.issues[0]?.message)
              if (
                trimmed.toLowerCase() ===
                // Stryker disable next-line MethodExpression: `email` is also type="email" — same unreachable-via-typing reasoning as this validator's own `trimmed` above
                fieldApi.form.getFieldValue('email').trim().toLowerCase()
              ) {
                return translateZodCode('PERSONAL_EMAIL_MUST_DIFFER')
              }
              return undefined
            },
          }}
        >
          {(field) => {
            // Same reasoning as the validator's dropped isDirty-gate
            // above: `errors` only ever populates via the onBlur
            // validator, which cannot run before a blur — so
            // `isTouched` is already true in every state where
            // `errors[0]` is non-empty. Gating render on
            // isTouched/isDirty on top of that can't hide anything
            // the validator itself doesn't already gate.
            const err = field.state.meta.errors[0]
            return (
              <Field
                label={t`Особистий email (необов’язково)`}
                error={err}
                // COPY-M-6 (copy-review PR #623 round 4): the OLD
                // hint repeated "входа" twice and, more
                // importantly, didn't say the one thing the admin
                // needs to know BEFORE clicking «Создать» — the
                // invite email goes out immediately on save
                // (UsersService.createUser calls sendInvite in the
                // same request).
                hint={t`На цю адресу одразу піде запрошення. Увійти з цією адресою співробітник зможе лише після її підтвердження.`}
              >
                <Input
                  type="email"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="ivan.petrov@gmail.com"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                  className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                  autoComplete="off"
                  data-testid="user-dialog-personal-email"
                />
              </Field>
            )
          }}
        </form.Field>
      )}

      <form.Field
        name="displayName"
        validators={{
          onBlur: ({ value, fieldApi }) => {
            if (!fieldApi.state.meta.isDirty) return undefined
            const r = z.string().min(2, 'zod.DISPLAY_NAME_MIN').max(255).safeParse(value.trim())
            // Stryker disable next-line OptionalChaining: issues[0] is guaranteed non-null on a failed safeParse — see this file's other field validators for the same invariant
            return r.success ? undefined : translateZodMessage(r.error.issues[0]?.message)
          },
        }}
      >
        {(field) => {
          // Stryker disable next-line ConditionalExpression,LogicalOperator: unobservable — the only validators are onBlur, so `errors[0]` can exist only after a blur (isTouched) and the validator itself bails on !isDirty; the gate cannot change what is rendered
          const showError = field.state.meta.isTouched && field.state.meta.isDirty
          const err = showError ? field.state.meta.errors[0] : undefined
          return (
            <Field label={t`Ім’я та прізвище`} error={err} required>
              <Input
                placeholder={t`Іваненко Іван Іванович`}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                autoCapitalize="words"
                autoComplete="off"
                className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                data-testid="user-dialog-name"
              />
            </Field>
          )
        }}
      </form.Field>

      <form.Field name="role">
        {(field) => {
          // ut-12: in Create, ADMIN is intentionally omitted.
          // ut-11: in Edit, self-ADMIN cannot change away from ADMIN.
          const optionList: readonly Role[] = isCreate
            ? (CREATE_ALLOWED_ROLES as readonly CreateAllowedRole[])
            : ROLES
          return (
            <Field
              label={t`Роль`}
              required
              hint={isSelfAdminEdit ? t`Свою роль змінити не можна` : undefined}
            >
              {hrOnly ? (
                <div className="flex items-center gap-2 rounded-md border border-input bg-muted/40 px-3 py-2">
                  <Badge variant="senior" className="text-[11px]">
                    {i18n._(ROLE_LABEL_MESSAGES.SENIOR)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    <Trans>(HR може створювати лише сеньйорів)</Trans>
                  </span>
                </div>
              ) : (
                <Select
                  value={field.state.value}
                  onValueChange={(v) => field.handleChange(v as Role)}
                  disabled={isSelfAdminEdit}
                >
                  <SelectTrigger data-testid="user-dialog-role-trigger">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {optionList.map((r) => (
                      <SelectItem key={r} value={r}>
                        <div className="flex items-center gap-2">
                          <Badge variant={ROLE_VARIANT[r]} className="text-[11px]">
                            {i18n._(ROLE_LABEL_MESSAGES[r])}
                          </Badge>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
          )
        }}
      </form.Field>

      {/* task-i18n-stage2 (Task 3, Step 6) — create-wizard-only:
          interface language for the new account. Language NAMES are
          given in their own language, not translated (owner decision —
          same convention as every language switcher in this app).
          task-i18n-stage3b-pr3: the field's own label/hint migrated. */}
      {isCreate && (
        <form.Field name="locale">
          {(field) => (
            <Field
              label={t`Мова інтерфейсу`}
              hint={t`Мова інтерфейсу співробітника — він зможе змінити її у своєму профілі.`}
              required
            >
              <Select
                value={field.state.value}
                onValueChange={(v) => field.handleChange(v as Locale)}
              >
                <SelectTrigger data-testid="user-locale-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="uk">Українська</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
        </form.Field>
      )}
    </Section>
  )
}
