import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { customVariableSchema } from '@crm/shared'
import type { CustomVariable } from '@crm/shared'
import { CONTRACT_VARIABLE_DESCRIPTIONS } from '@crm/shared'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

const KEY_REGEX = /^[a-zA-Z][a-zA-Z0-9_]{0,49}$/

interface AddCustomVariableDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  existingCustomKeys: string[]
  /** Pre-filled key (from «+ Зарегистрировать» sync-warning action) */
  prefillKey?: string
  onAdd: (variable: CustomVariable) => void
}

export function AddCustomVariableDialog({
  open,
  onOpenChange,
  existingCustomKeys,
  prefillKey = '',
  onAdd,
}: AddCustomVariableDialogProps) {
  const { t } = useLingui()
  const [key, setKey] = useState(prefillKey)
  const [label, setLabel] = useState('')
  const [defaultValue, setDefaultValue] = useState('')
  const [keyError, setKeyError] = useState<string | undefined>()
  const [labelError, setLabelError] = useState<string | undefined>()

  const systemKeys = new Set(Object.keys(CONTRACT_VARIABLE_DESCRIPTIONS))

  function handleOpenChange(v: boolean) {
    if (!v) {
      setKey(prefillKey)
      setLabel('')
      setDefaultValue('')
      setKeyError(undefined)
      setLabelError(undefined)
    }
    onOpenChange(v)
  }

  // Reset fields when prefillKey changes (e.g. dialog reopened from sync-warning)
  const handleKeyChange = (v: string) => {
    setKey(v)
    setKeyError(undefined)
  }

  const handleLabelChange = (v: string) => {
    setLabel(v)
    setLabelError(undefined)
  }

  function validate(): boolean {
    let valid = true

    if (!KEY_REGEX.test(key.trim())) {
      setKeyError(t`Лише латиниця, починається з букви, макс. 50 символів`)
      valid = false
    } else if (systemKeys.has(key.trim())) {
      setKeyError(t`Ключ зарезервовано системою`)
      valid = false
    } else if (existingCustomKeys.includes(key.trim())) {
      setKeyError(t`Змінна з таким ключом уже існує`)
      valid = false
    }

    if (!label.trim()) {
      setLabelError(t`Назва обов’язкова`)
      valid = false
    }

    return valid
  }

  function handleSubmit() {
    if (!validate()) return

    const parsed = customVariableSchema.safeParse({
      key: key.trim(),
      label: label.trim(),
      defaultValue: defaultValue.trim() || undefined,
    })

    if (!parsed.success) {
      const first = parsed.error.issues[0]
      if (first?.path[0] === 'key') setKeyError(first.message)
      else if (first?.path[0] === 'label') setLabelError(first.message)
      return
    }

    onAdd(parsed.data)
    handleOpenChange(false)
  }

  const keyTrimmed = key.trim()
  const previewToken = keyTrimmed && KEY_REGEX.test(keyTrimmed) ? `{{${keyTrimmed}}}` : null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm" data-testid="add-custom-variable-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Нова змінна</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Додайте кастомну змінну. Співробітник заповнить її значення під час підписання.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {/* Key */}
          <div className="grid gap-1.5">
            <Label htmlFor="cv-key">
              <Trans>Ключ змінної (латиниця, camelCase)</Trans>
              <span className="text-destructive ml-0.5">*</span>
            </Label>
            <Input
              id="cv-key"
              placeholder="contractCity"
              value={key}
              onChange={(e) => handleKeyChange(e.target.value)}
              data-testid="cv-key-input"
              autoCapitalize="off"
              autoCorrect="off"
              className={cn(keyError && 'border-destructive focus-visible:ring-destructive/30')}
              autoComplete="off"
            />
            {keyError && <p className="text-[11px] text-destructive">{keyError}</p>}
          </div>

          {/* Label */}
          <div className="grid gap-1.5">
            <Label htmlFor="cv-label">
              <Trans>Назва для форми</Trans>
              <span className="text-destructive ml-0.5">*</span>
            </Label>
            <Input
              id="cv-label"
              // Stryker disable next-line StringLiteral: placeholder text only, no test reads an <input>'s placeholder attribute for this field — genuinely unobservable by the unit suite.
              placeholder={t`Місто підписання`}
              value={label}
              onChange={(e) => handleLabelChange(e.target.value)}
              data-testid="cv-label-input"
              className={cn(labelError && 'border-destructive focus-visible:ring-destructive/30')}
            />
            {labelError && <p className="text-[11px] text-destructive">{labelError}</p>}
          </div>

          {/* Default value */}
          <div className="grid gap-1.5">
            <Label htmlFor="cv-default">
              <Trans>Значення за замовчуванням (необов’язково)</Trans>
            </Label>
            <Input
              id="cv-default"
              // Stryker disable next-line StringLiteral: placeholder text only, no test reads an <input>'s placeholder attribute for this field — genuinely unobservable by the unit suite.
              placeholder={t`Київ`}
              value={defaultValue}
              onChange={(e) => setDefaultValue(e.target.value)}
              data-testid="cv-default-input"
            />
          </div>

          {/* Token preview */}
          {previewToken && (
            <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2">
              <span className="text-xs text-muted-foreground">
                <Trans>Підсумковий токен:</Trans>
              </span>
              <code className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-xs text-amber-700 dark:text-amber-300">
                {previewToken}
              </code>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            data-testid="cv-cancel-button"
          >
            <Trans>Скасувати</Trans>
          </Button>
          <Button onClick={handleSubmit} data-testid="cv-add-button">
            <Trans>Додати</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Inline confirm dialog for deleting a custom variable.
 */
interface DeleteCustomVariableDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  variableKey: string
  onConfirm: () => void
}

export function DeleteCustomVariableDialog({
  open,
  onOpenChange,
  variableKey,
  onConfirm,
}: DeleteCustomVariableDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" data-testid="delete-custom-variable-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Видалити змінну?</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Змінна{' '}
              <code className="rounded bg-amber-500/15 px-1 font-mono text-xs text-amber-700 dark:text-amber-300">
                {`{{${variableKey}}}`}
              </code>{' '}
              буде видалена зі списку кастомних. Токен лишиться в тексті як нерозпізнаний — видаліть
              його вручну з редактора.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="delete-cv-cancel-button"
          >
            <Trans>Скасувати</Trans>
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onConfirm()
              onOpenChange(false)
            }}
            data-testid="delete-cv-confirm-button"
          >
            <Trans>Видалити</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
