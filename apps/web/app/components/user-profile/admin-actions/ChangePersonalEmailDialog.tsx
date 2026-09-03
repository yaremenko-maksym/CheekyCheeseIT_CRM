import { useState } from 'react'
import { z } from 'zod'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useChangePersonalEmail } from '@/hooks/use-user-profile'

/** Mirrors `createUserSchema.personalEmail` (`@crm/shared`) — same bound,
 * same message, kept local since this dialog posts to a dedicated
 * endpoint (`changePersonalEmailSchema`), not that schema. */
const personalEmailValidator = z
  .string()
  .email('Некорректный email')
  .max(255, 'Email не длиннее 255 символов')

/**
 * ADMIN action (security-review PR #623 round 4, owner decision — see
 * `changePersonalEmailSchema`'s doc, `@crm/shared`): fast, unconditional fix
 * for a mistyped personal address. Changing OR removing it (empty field)
 * revokes login on whatever address was there before, IMMEDIATELY — see
 * `UsersService.changePersonalEmail`. A new address goes through the same
 * invite flow as one entered at creation.
 *
 * Deliberately mirrors `AdminNoteDialog`'s shape (same primitives: `Dialog`
 * / `Label` / `Input` / `Button`, no new visual surface) rather than
 * reusing `UserDialog`'s multi-step wizard — this is a single-purpose,
 * security-sensitive write with its own endpoint and its own audit action,
 * and stays isolated from that much larger component.
 *
 * copy-review PR #623 round 5 (COPY-H-4/M-10/M-11/M-12): title, description
 * and the submit button label all now depend on TWO states this dialog can
 * be in, and the copy must not lie about either:
 *   - `currentEmail === null` — there is nothing to change or revoke yet
 *     (see `AdminActionsMenu`'s `canChangePersonalEmail`, which shows this
 *     entry point even when no personal address exists at all). The
 *     "closes login on the old address" warning would be a claim about an
 *     address that does not exist — so this state gets its own, true copy.
 *   - `currentEmail` set — the ordinary change/remove case; wording taken
 *     verbatim from the round-5 copy review (measured against this
 *     dialog's real content width, 272px).
 */
export function ChangePersonalEmailDialog({
  userId,
  currentEmail,
  workEmail,
  onClose,
}: {
  userId: string
  currentEmail: string | null
  workEmail: string
  onClose: () => void
}) {
  const mutation = useChangePersonalEmail(userId)
  const [value, setValue] = useState(currentEmail ?? '')
  const [error, setError] = useState<string | null>(null)

  const isAdding = currentEmail === null
  const trimmed = value.trim()
  const isRemoval = !trimmed && !!currentEmail
  const isNoop = trimmed === (currentEmail ?? '')
  // ui-ux-designer PR #623 fidelity audit (round 2): per this component's
  // own doc block, saving revokes the OLD address the instant `currentEmail`
  // is non-null — true for both `isRemoval` (field cleared) AND an ordinary
  // change (field holds a different, valid address). Only the FIRST-time
  // set (`currentEmail === null`, nothing to revoke) is purely additive.
  // `ArchiveUserDialog`'s submit button uses the same `destructive` variant
  // for its own irreversible action, and `AdminActionsMenu`'s "Архивировать"
  // item is styled the same red — this dialog's default (`primary`, same
  // gold as a no-consequence "Сохранить") didn't visually distinguish a
  // credential-revoking save from a benign one. Text label is unchanged
  // here (copy-review PR #623 round 4 owns that wording separately).
  //
  // COPY-L-3 (security-review PR #623 closing round) — revisited, kept as
  // is: `ArchiveUserDialog`'s own destructive button DOES name the action
  // ("Архивировать", not "Сохранить"), which is the stronger precedent and
  // an argument for renaming this one too. Not doing it: (1) "Сохранить" is
  // still the grammatically correct verb for what this click actually does
  // in the CHANGE case — persist a new value — unlike an archive/delete
  // action that has no less-severe reading; (2) the consequence is already
  // spelled out in PROSE immediately above the button (`description`
  // below), so the admin is not relying on the button label alone the way
  // `ArchiveUserDialog`'s confirmation (typed name, no body text) does; (3)
  // an existing regression test
  // (`ChangePersonalEmailDialog.test.tsx`, "submit button is the
  // destructive variant … even though the label stays 'Сохранить'") already
  // pins this as the round-4 reviewer's deliberate call, not an oversight —
  // reversing a settled, tested decision on a LOW finding in the closing
  // round needs a real defect, not a stylistic preference either way.
  const revokesExisting = !!currentEmail

  function validate(): string | null {
    if (!trimmed) return null // empty = removal, always a valid submission
    const result = personalEmailValidator.safeParse(trimmed)
    if (!result.success) return result.error.issues[0]?.message ?? 'Некорректный email'
    if (trimmed.toLowerCase() === workEmail.toLowerCase()) {
      return 'Личный email должен отличаться от рабочего'
    }
    return null
  }

  async function submit() {
    const err = validate()
    if (err) {
      setError(err)
      return
    }
    await mutation.mutateAsync(trimmed || null)
    onClose()
  }

  // copy-review PR #623 round 5 (COPY-H-4/M-11/M-12) — the description is an
  // action verb ("Сохраните — и …" / "Удалите — и …"), not a field label,
  // and names the consequence truthfully for whichever of the three states
  // the dialog is actually in: adding a first address (nothing to revoke
  // yet — COPY-M-12), removing the only address (no new address to
  // mention — COPY-M-11), or changing an existing one (both halves apply —
  // COPY-H-4). Wording taken verbatim from the round-5 copy review, measured
  // against this dialog's real content width (272px).
  //
  // COPY-M-14 (security-review PR #623 closing round): the removal branch
  // used to open with "Сохраните" while the submit button below reads
  // "Удалить адрес" — the description commanded a DIFFERENT verb than the
  // one action actually available in this state. Swapped to "Удалите",
  // matching the button; the rest of the sentence is unchanged (round-5
  // copy review's own wording, still true for the removal case).
  const description = isAdding
    ? 'На этот адрес сразу уйдёт приглашение. Входить по нему сотрудник сможет только после того, как подтвердит адрес.'
    : isRemoval
      ? 'Удалите — и вход по этому адресу закроется сразу, даже если сотрудник уже подтвердил его.'
      : 'Сохраните — и вход по нынешнему адресу закроется сразу, даже если сотрудник уже подтвердил его. На новый адрес уйдёт приглашение.'

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent onCloseAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          {/* COPY-M-10: title names the ACTION (matches ArchiveUserDialog's
              own house style), not the field — the field already has its
              own <Label> 40px below, and repeating it there was the finding. */}
          <DialogTitle>{isAdding ? 'Добавить личный email' : 'Изменить личный email'}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {/* ui-ux-designer PR #623 fidelity audit (round 2): this field is
              `UserDialog`'s `personalEmail` field under another name (same
              validator, same two error strings) — that sibling marks BOTH
              the label and the input red on error
              (`border-destructive focus-visible:ring-destructive/30`,
              `UserDialog.tsx`'s `form.Field` for this exact field). This
              copy had the red error TEXT but a plain, unchanged border and
              label — verified live: the input stayed neutral-gray while a
              red error line sat directly under it. Matched to the sibling's
              exact classes, not invented fresh. */}
          <Label htmlFor="change-personal-email-input" className={cn(error && 'text-destructive')}>
            Личный email
          </Label>
          <Input
            id="change-personal-email-input"
            type="email"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            // EMAIL_NO_AUTOFILL (mobile-keyboard-registry.ts) — someone
            // ELSE's email, entered by an admin: the admin's own saved
            // address must never autofill into another person's record,
            // same posture as UserDialog's email/personalEmail fields.
            autoComplete="off"
            placeholder="ivan.petrov@gmail.com"
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              if (error) setError(null)
            }}
            onBlur={() => setError(validate())}
            className={cn(error && 'border-destructive focus-visible:ring-destructive/30')}
            data-testid="change-personal-email-input"
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          {/* COPY-M-11: the standalone hint that used to live here repeated
              what the description above already says once the description
              itself names the removal consequence — removed, not softened. */}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant={revokesExisting ? 'destructive' : 'default'}
            disabled={mutation.isPending || isNoop}
            onClick={() => void submit()}
            data-testid="change-personal-email-submit"
          >
            {/* COPY-M-11: the button names the actual destructive action
                instead of the neutral "Сохранить" — the last word the admin
                reads before an irreversible revoke must not be the softest
                one in the dialog (ArchiveUserDialog's own precedent). */}
            {isRemoval ? 'Удалить адрес' : 'Сохранить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
