/**
 * ProjectLegendSection — Легенда синьора в контексте проекта.
 *
 * RBAC (per-project, subject excluded):
 *   Доступ (view == edit): ADMIN, HR из той же команды, активный JUNIOR проекта.
 *   Субъект (seniorId / dropId) — НЕ видит свою легенду.
 *   Остальные (ACCOUNTANT, другой SENIOR) — не видят.
 *
 * Props:
 *   projectId — UUID проекта
 *   canAccess — управляет видимостью секции целиком (вычисляется снаружи)
 */
import { useState } from 'react'
import { useLingui } from '@lingui/react/macro'
import { BookOpen, Loader2, Pencil, Plus, Save, X } from 'lucide-react'
import { useForm } from '@tanstack/react-form'
import { upsertLegendSchema, formatDate } from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useAddLegendEntry, useLegend, useUpsertLegend } from '@/hooks/use-legend'
import { useLocale } from '@/lib/i18n'

interface ProjectLegendSectionProps {
  projectId: string
  /** When false the section is hidden entirely (viewer lacks access). */
  canAccess: boolean
}

export function ProjectLegendSection({ projectId, canAccess }: ProjectLegendSectionProps) {
  const { t } = useLingui()
  const locale = useLocale()
  const { data: legend, isLoading } = useLegend(projectId, canAccess)
  const upsert = useUpsertLegend(projectId)
  const addEntry = useAddLegendEntry(projectId)
  const [editing, setEditing] = useState(false)
  const [entryText, setEntryText] = useState('')
  const [showEntryForm, setShowEntryForm] = useState(false)

  const form = useForm({
    defaultValues: {
      fullName: legend?.fullName ?? '',
      dateOfBirth: legend?.dateOfBirth ?? '',
      address: legend?.address ?? '',
      presentedRole: legend?.presentedRole ?? '',
      presentedStack: legend?.presentedStack ?? '',
      backstory: legend?.backstory ?? '',
      hobbies: legend?.hobbies ?? '',
      notes: legend?.notes ?? '',
    },
    onSubmit: async ({ value }) => {
      const dto = upsertLegendSchema.parse({
        fullName: value.fullName,
        dateOfBirth: value.dateOfBirth || null,
        address: value.address || null,
        presentedRole: value.presentedRole || null,
        presentedStack: value.presentedStack || null,
        backstory: value.backstory || null,
        hobbies: value.hobbies || null,
        notes: value.notes || null,
      })
      await upsert.mutateAsync(dto)
      setEditing(false)
    },
  })

  if (!canAccess) return null

  if (isLoading) {
    return (
      <Card data-testid="legend-section" className="border-border/40">
        <CardHeader>
          <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            {t`Легенда`}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </CardContent>
      </Card>
    )
  }

  const handleEdit = () => {
    form.reset({
      fullName: legend?.fullName ?? '',
      dateOfBirth: legend?.dateOfBirth ?? '',
      address: legend?.address ?? '',
      presentedRole: legend?.presentedRole ?? '',
      presentedStack: legend?.presentedStack ?? '',
      backstory: legend?.backstory ?? '',
      hobbies: legend?.hobbies ?? '',
      notes: legend?.notes ?? '',
    })
    setEditing(true)
  }

  const handleCancel = () => {
    form.reset()
    setEditing(false)
  }

  const handleAddEntry = async () => {
    if (!entryText.trim()) return
    await addEntry.mutateAsync({ text: entryText.trim() })
    setEntryText('')
    setShowEntryForm(false)
  }

  // ── Read-only view ────────────────────────────────────────────────────────
  if (!editing) {
    return (
      <Card data-testid="legend-section" className="border-border/40 col-span-full">
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <BookOpen className="h-3.5 w-3.5" />
            {t`Легенда`}
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleEdit}
            disabled={upsert.isPending}
            data-testid="legend-edit-button"
            className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <Pencil className="h-3 w-3" />
            {legend ? t`Редагувати` : t`Створити`}
          </Button>
        </CardHeader>
        <CardContent>
          {!legend ? (
            <p className="text-sm text-muted-foreground/60 italic">{t`Легенда не заповнена`}</p>
          ) : (
            <div className="space-y-4">
              <dl
                className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm"
                data-testid="legend-readonly"
              >
                {legend.fullName && (
                  <div>
                    <dt className="text-xs text-muted-foreground mb-0.5">{t`ПІБ`}</dt>
                    <dd className="font-medium" data-testid="legend-fullname">
                      {legend.fullName}
                    </dd>
                  </div>
                )}
                {legend.dateOfBirth && (
                  <div>
                    <dt className="text-xs text-muted-foreground mb-0.5">{t`Дата народження`}</dt>
                    <dd data-testid="legend-dob">{legend.dateOfBirth}</dd>
                  </div>
                )}
                {legend.address && (
                  <div className="sm:col-span-2">
                    <dt className="text-xs text-muted-foreground mb-0.5">{t`Адреса`}</dt>
                    <dd data-testid="legend-address">{legend.address}</dd>
                  </div>
                )}
                {legend.presentedRole && (
                  <div>
                    <dt className="text-xs text-muted-foreground mb-0.5">{t`Посада для клієнта`}</dt>
                    <dd data-testid="legend-presented-role">{legend.presentedRole}</dd>
                  </div>
                )}
                {legend.presentedStack && (
                  <div>
                    <dt className="text-xs text-muted-foreground mb-0.5">{t`Стек для клієнта`}</dt>
                    <dd data-testid="legend-presented-stack">{legend.presentedStack}</dd>
                  </div>
                )}
                {legend.backstory && (
                  <div className="sm:col-span-2">
                    <dt className="text-xs text-muted-foreground mb-0.5">{t`Бекстори`}</dt>
                    <dd className="whitespace-pre-wrap" data-testid="legend-backstory">
                      {legend.backstory}
                    </dd>
                  </div>
                )}
                {legend.hobbies && (
                  <div>
                    <dt className="text-xs text-muted-foreground mb-0.5">{t`Хобі`}</dt>
                    <dd data-testid="legend-hobbies">{legend.hobbies}</dd>
                  </div>
                )}
                {legend.notes && (
                  <div className="sm:col-span-2">
                    <dt className="text-xs text-muted-foreground mb-0.5">{t`Примітки`}</dt>
                    <dd className="whitespace-pre-wrap" data-testid="legend-notes">
                      {legend.notes}
                    </dd>
                  </div>
                )}
              </dl>

              {/* Journal entries */}
              {legend.entries.length > 0 && (
                <div className="pt-3 border-t border-border/30" data-testid="legend-entries">
                  <p className="text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider mb-2">
                    {t`Журнал`}
                  </p>
                  <ol className="space-y-2">
                    {legend.entries.map((entry) => (
                      <li key={entry.id} className="text-sm" data-testid="legend-entry">
                        <span className="text-muted-foreground text-xs mr-1.5">
                          {formatDate(entry.createdAt, locale, 'short')}
                          {' · '}
                          {entry.authorName}:
                        </span>
                        <span className="whitespace-pre-wrap">{entry.text}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {/* Add journal entry */}
              {!showEntryForm ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowEntryForm(true)}
                  data-testid="legend-add-entry-button"
                  className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
                >
                  <Plus className="h-3 w-3" />
                  {t`Додати запис`}
                </Button>
              ) : (
                <div className="space-y-2 pt-2" data-testid="legend-entry-form">
                  <Textarea
                    value={entryText}
                    onChange={(e) => setEntryText(e.target.value)}
                    placeholder={t`Новий запис у журнал легенди...`}
                    rows={3}
                    data-testid="legend-entry-input"
                    className="text-sm"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => void handleAddEntry()}
                      disabled={addEntry.isPending || !entryText.trim()}
                      data-testid="legend-entry-save-button"
                    >
                      {addEntry.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                      ) : (
                        <Save className="h-3.5 w-3.5 mr-1" />
                      )}
                      {t`Зберегти запис`}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setShowEntryForm(false)
                        setEntryText('')
                      }}
                      data-testid="legend-entry-cancel-button"
                    >
                      <X className="h-3.5 w-3.5 mr-1" />
                      {t`Скасувати`}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    )
  }

  // ── Edit form ─────────────────────────────────────────────────────────────
  return (
    <Card data-testid="legend-section" className="border-border/40 col-span-full">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <BookOpen className="h-3.5 w-3.5" />
          {t`Легенда`}
        </CardTitle>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCancel}
          data-testid="legend-cancel-button"
          className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
          {t`Скасувати`}
        </Button>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            e.stopPropagation()
            void form.handleSubmit()
          }}
          className="space-y-4"
          data-testid="legend-form"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <form.Field name="fullName">
              {(field) => (
                <div className="space-y-1">
                  <Label htmlFor="legend-fullName">{t`ПІБ *`}</Label>
                  <Input
                    id="legend-fullName"
                    data-testid="legend-input-fullname"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder={t`Іванов Іван Іванович`}
                    autoCapitalize="words"
                    autoComplete="off"
                  />
                  {field.state.meta.errors.length > 0 && (
                    <p className="text-xs text-destructive">{String(field.state.meta.errors[0])}</p>
                  )}
                </div>
              )}
            </form.Field>

            <form.Field name="dateOfBirth">
              {(field) => (
                <div className="space-y-1">
                  <Label htmlFor="legend-dateOfBirth">{t`Дата народження`}</Label>
                  <Input
                    id="legend-dateOfBirth"
                    data-testid="legend-input-dob"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="1990-01-15"
                  />
                </div>
              )}
            </form.Field>

            <form.Field name="presentedRole">
              {(field) => (
                <div className="space-y-1">
                  <Label htmlFor="legend-presentedRole">{t`Посада для клієнта`}</Label>
                  <Input
                    id="legend-presentedRole"
                    data-testid="legend-input-presented-role"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="Senior Frontend Developer"
                  />
                </div>
              )}
            </form.Field>

            <form.Field name="presentedStack">
              {(field) => (
                <div className="space-y-1">
                  <Label htmlFor="legend-presentedStack">{t`Стек для клієнта`}</Label>
                  <Input
                    id="legend-presentedStack"
                    data-testid="legend-input-presented-stack"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="React, TypeScript, Node.js"
                  />
                </div>
              )}
            </form.Field>
          </div>

          <form.Field name="address">
            {(field) => (
              <div className="space-y-1">
                <Label htmlFor="legend-address">{t`Адреса`}</Label>
                <Input
                  id="legend-address"
                  data-testid="legend-input-address"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder={t`Київ, вул. Хрещатик, 1`}
                />
              </div>
            )}
          </form.Field>

          <form.Field name="backstory">
            {(field) => (
              <div className="space-y-1">
                <Label htmlFor="legend-backstory">{t`Бекстори`}</Label>
                <Textarea
                  id="legend-backstory"
                  data-testid="legend-input-backstory"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder={t`Коротка історія для клієнтської компанії...`}
                  rows={3}
                />
              </div>
            )}
          </form.Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <form.Field name="hobbies">
              {(field) => (
                <div className="space-y-1">
                  <Label htmlFor="legend-hobbies">{t`Хобі`}</Label>
                  <Input
                    id="legend-hobbies"
                    data-testid="legend-input-hobbies"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder={t`Читання, плавання...`}
                  />
                </div>
              )}
            </form.Field>
          </div>

          <form.Field name="notes">
            {(field) => (
              <div className="space-y-1">
                <Label htmlFor="legend-notes">{t`Примітки`}</Label>
                <Textarea
                  id="legend-notes"
                  data-testid="legend-input-notes"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder={t`Додаткова інформація...`}
                  rows={3}
                />
              </div>
            )}
          </form.Field>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCancel}
              data-testid="legend-cancel-button-bottom"
            >
              {t`Скасувати`}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={upsert.isPending}
              data-testid="legend-save-button"
            >
              {upsert.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <Save className="h-4 w-4 mr-1" />
              )}
              {t`Зберегти`}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
