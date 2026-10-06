import type { ReactFormExtendedApi } from '@tanstack/react-form'
import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/crm-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ShareSlider } from '@/components/ui/share-slider'

// TanStack Form render props require many generics — same suppression as the
// UserDialog sections (the form instance is owned by the team page root).
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyForm = ReactFormExtendedApi<any, any, any, any, any, any, any, any, any, any, any, any>
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Presentational "Edit team" dialog. SECURITY + FINANCE-SENSITIVE: edits the
 * senior drop-share override (`seniorSharePercentOverride`, a payout-split
 * input). The `useForm` instance, the Header edit-button seeding and the
 * submit-time empty -> null parse of the override all stay in the page root;
 * this component only renders the inputs against the form it is handed.
 */
export function EditTeamDialog({
  open,
  onOpenChange,
  form,
  isPending,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  form: Pick<AnyForm, 'Field' | 'handleSubmit'>
  isPending: boolean
}) {
  const { t } = useLingui()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <CrmDialogContent>
        <CrmDialogHeader>
          <DialogTitle>
            <Trans>Редагувати команду</Trans>
          </DialogTitle>
          <DialogDescription className="sr-only">
            <Trans>Редагування назви, Telegram-посилання та заміток команди.</Trans>
          </DialogDescription>
        </CrmDialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void form.handleSubmit()
          }}
        >
          <CrmDialogBody className="space-y-4">
            <form.Field name="name">
              {(field) => (
                <div className="grid gap-1.5">
                  <Label htmlFor="edit-name">
                    <Trans>Назва</Trans> <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="edit-name"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder={t`Назва команди`}
                  />
                  {field.state.meta.errors[0] && (
                    <p className="text-xs text-destructive">{field.state.meta.errors[0]}</p>
                  )}
                </div>
              )}
            </form.Field>
            <form.Field
              name="telegram"
              validators={{
                onChange: ({ value }) => {
                  if (value && !value.startsWith('https://t.me/')) {
                    return t`Посилання має починатися з https://t.me/`
                  }
                  return undefined
                },
              }}
            >
              {(field) => (
                <div className="grid gap-1.5">
                  <Label htmlFor="edit-telegram">Telegram</Label>
                  <Input
                    id="edit-telegram"
                    type="url"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="https://t.me/team_chat"
                  />
                  {field.state.meta.errors[0] && (
                    <p className="text-xs text-destructive">{String(field.state.meta.errors[0])}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    <Trans>Посилання на Telegram-чат команди</Trans>
                  </p>
                </div>
              )}
            </form.Field>
            <form.Field name="notes">
              {(field) => (
                <div className="grid gap-1.5">
                  <Label htmlFor="edit-notes">
                    <Trans>Замітки</Trans>
                  </Label>
                  <Textarea
                    id="edit-notes"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder={t`Внутрішні замітки…`}
                    className="min-h-20"
                  />
                </div>
              )}
            </form.Field>
            {/*
            task-team-senior-share-override. Team-level override for the
            SENIOR's share percent. Empty string = "no override → fall
            through to project / user default". ShareSlider replaces the
            plain number input (UT #9). Default shown when no override is
            set. The reset button clears back to empty (no override).
          */}
            <form.Field name="seniorSharePercentOverride">
              {(field) => {
                const raw = field.state.value
                const hasOverride = raw.trim() !== ''
                // Slider value: override if set, else 26 (global default).
                const sliderValue = hasOverride ? Math.min(100, Math.max(0, Number(raw))) : 26
                return (
                  <div className="grid gap-1.5">
                    <div className="flex items-center justify-between">
                      <Label>
                        <Trans>Частка сеньйора на рівні команди</Trans>
                      </Label>
                      {hasOverride && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-muted-foreground"
                          onClick={() => field.handleChange('')}
                          data-testid="team-edit-senior-share-override-reset"
                        >
                          <Trans>Скинути</Trans>
                        </Button>
                      )}
                    </div>
                    <ShareSlider
                      value={sliderValue}
                      min={0}
                      max={100}
                      onChange={(v) => field.handleChange(String(v))}
                      onBlur={field.handleBlur}
                      inputTestId="team-edit-senior-share-override-input"
                    />
                    <p className="text-xs text-muted-foreground">
                      {hasOverride ? (
                        <Trans>
                          Задано для команди. Діє на всіх її проєктах, крім тих, де є індивідуальна
                          частка за проєктом.
                        </Trans>
                      ) : (
                        <Trans>
                          Не задано — діє частка сеньйора за замовчуванням (26%, якщо не змінювали).
                          Пересуньте повзунок, щоб задати частку для команди.
                        </Trans>
                      )}
                    </p>
                  </div>
                )
              }}
            </form.Field>
          </CrmDialogBody>
          <CrmDialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              <Trans>Скасувати</Trans>
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? t`Зберігаємо…` : t`Зберегти`}
            </Button>
          </CrmDialogFooter>
        </form>
      </CrmDialogContent>
    </Dialog>
  )
}
