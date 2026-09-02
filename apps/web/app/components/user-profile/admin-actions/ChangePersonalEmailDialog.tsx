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

  const trimmed = value.trim()
  const isRemoval = !trimmed && !!currentEmail
  const isNoop = trimmed === (currentEmail ?? '')

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

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent onCloseAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Личный email</DialogTitle>
          <DialogDescription>
            Смена или удаление немедленно закроют вход со старого адреса — даже если сотрудник уже
            подтвердил его. Новый адрес пройдёт то же приглашение по почте.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="change-personal-email-input">Личный email</Label>
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
            data-testid="change-personal-email-input"
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          {!error && isRemoval && (
            <p className="text-xs text-muted-foreground">
              Поле пустое — сохранение удалит личный адрес и закроет вход по нему.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={mutation.isPending || isNoop}
            onClick={() => void submit()}
            data-testid="change-personal-email-submit"
          >
            Сохранить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
