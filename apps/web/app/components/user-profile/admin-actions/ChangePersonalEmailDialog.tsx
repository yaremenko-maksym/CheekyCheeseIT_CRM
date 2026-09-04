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
    // zod's SafeParseError.error.issues is never empty on a failed parse
    // (verified: packages/shared, zod's own contract) — `issues[0]` cannot
    // be undefined here. Same invariant, same suppression, as this field's
    // sibling in UserDialog.tsx (`personalEmail`'s own validator).
    // Stryker disable next-line OptionalChaining: issues[0] is guaranteed non-null on a failed safeParse — see the comment above
    if (!result.success) return result.error.issues[0]?.message ?? 'Некорректный email'
    if (trimmed.toLowerCase() === workEmail.toLowerCase()) {
      return 'Личный email должен отличаться от рабочего'
    }
    return null
  }

  // Prevents Radix's default post-close focus-return so this dialog's own
  // close cycle does not fight `AdminActionsMenu`'s dropdown-trigger focus
  // handling. Not asserted directly: two independent harnesses were built
  // to observe it (routing Escape through `AdminActionsMenu` itself, and a
  // standalone toggle wrapper with a persistent trigger button, mirroring
  // the working pattern `AdminActionsMenu.test.tsx` uses for its OWN Radix
  // DropdownMenu trigger) — hand-applying `() => undefined` here and
  // re-running both showed no observable difference either way; happy-dom
  // does not simulate Radix `FocusScope`'s restore-on-unmount closely
  // enough for either harness to tell the two apart. Pulled out to a named
  // const (rather than left inline on the JSX prop) specifically so this
  // suppression comment can attach to a real line — Stryker's `// Stryker
  // disable next-line` only recognises literal `//` comments immediately
  // preceding the mutated line, which a `{/* JSX comment */}` sibling does
  // NOT satisfy (verified: that form compiled fine but the mutant it was
  // meant to silence still showed as SURVIVED).
  // Stryker disable next-line ArrowFunction: unobservable in this test harness — see the comment above
  const handleDialogCloseAutoFocus = (e: Event) => e.preventDefault()

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
  //
  // COPY-M-16 (copy-review PR #623 closing round): "Удалите" is shorter
  // than "Сохраните" (the change-branch's verb below), so the removal
  // sentence reflows to one word less per line at the mandatory 375px
  // mobile width (responsive-design.md) — the last line ends up a single
  // hanging word, "его.". Fixed with a non-breaking space (U+00A0, not the
  // HTML entity `&nbsp;` — this is a JS string literal, not JSX text;
  // precedent: the raw NBSP character in `terminal.tsx`) between
  // "подтвердил" and "его.", keeping them on the same line. Does not touch
  // the change-branch sentence below, which already wraps cleanly at every
  // width this dialog is measured at.
  // Does not touch the change-branch sentence below: at 375px it wraps to
  // four lines ending on «приглашение.» — a full content word at 95px of a
  // 325px measure, not an orphan. The same nbsp there changes nothing
  // (measured: 4 lines with it, 4 without — `text-wrap: wrap` is greedy, so
  // an nbsp can only hold the line count or raise it, never lower it).
  const description = isAdding
    ? 'На этот адрес сразу уйдёт приглашение. Входить по нему сотрудник сможет только после того, как подтвердит адрес.'
    : isRemoval
      ? 'Удалите — и вход по этому адресу закроется сразу, даже если сотрудник уже подтвердил его.'
      : 'Сохраните — и вход по нынешнему адресу закроется сразу, даже если сотрудник уже подтвердил его. На новый адрес уйдёт приглашение.'

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent onCloseAutoFocus={handleDialogCloseAutoFocus}>
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
              // Unconditional, deliberately: React 18's useState setter
              // bails out of re-rendering when the new value is
              // Object.is-equal to the current one (React docs, "Bailing
              // out of a state update") — an `if (error)` guard here would
              // only ever skip a call that was ALREADY a no-op whenever
              // `error` is `null`, so it bought nothing but an extra
              // conditional expression a mutation test would then have to
              // prove is equivalent to `if (true)`, which it provably is.
              setError(null)
            }}
            onBlur={() => setError(validate())}
            className={cn(error && 'border-destructive focus-visible:ring-destructive/30')}
            data-testid="change-personal-email-input"
          />
          {error && (
            <p className="text-xs text-destructive" data-testid="change-personal-email-error">
              {error}
            </p>
          )}
          {/* COPY-M-11: the standalone hint that used to live here repeated
              what the description above already says once the description
              itself names the removal consequence — removed, not softened. */}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant={
              revokesExisting
                ? // Pinned by the sibling test just above (`toContain('bg-destructive')`)
                  // — a StringLiteral mutant on THIS branch is a real, killed mutant,
                  // deliberately NOT covered by the suppression on the branch below.
                  'destructive'
                : // `class-variance-authority`'s documented falsy-value handling (cva
                  // "Falsy Value Handling": false/0/''/null/undefined all fall back to
                  // `defaultVariants`) makes 'default' here interchangeable with an
                  // empty string — `Button`'s own `defaultVariants.variant`
                  // (button.tsx) is ALSO 'default', so `''` resolves to the exact same
                  // className cva would produce for the literal 'default' — not an
                  // assumption, cva's own documented contract. On its own line
                  // specifically so this suppression does NOT also cover the
                  // 'destructive' branch above, which a Stryker `// disable next-line`
                  // on the single-line ternary this used to be would have (verified —
                  // that shape triggered mutation-gate.mjs's own "covers more than one
                  // mutant" warning).
                  // Stryker disable next-line StringLiteral: '' is cva-equivalent to 'default' here — see the comment above
                  'default'
            }
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
