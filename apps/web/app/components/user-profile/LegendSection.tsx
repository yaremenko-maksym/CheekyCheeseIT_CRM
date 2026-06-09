/**
 * LegendSection — Легенда SENIOR
 *
 * Editable: SENIOR (self) + ADMIN
 * Read-only: HR (own senior), JUNIOR (project senior)
 * Hidden: ACCOUNTANT, DROP, other SENIOR (403 on GET)
 *
 * Props:
 *  userId  — target user's UUID
 *  canEdit — true only for self-SENIOR or ADMIN
 */
import { useState } from 'react'
import { Loader2, Pencil, Save, X } from 'lucide-react'
import { useForm } from '@tanstack/react-form'
import { upsertLegendSchema } from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useLegend, useUpsertLegend } from '@/hooks/use-legend'

interface LegendSectionProps {
  userId: string
  canEdit: boolean
}

export function LegendSection({ userId, canEdit }: LegendSectionProps) {
  const { data: legend, isLoading, error } = useLegend(userId)
  const upsert = useUpsertLegend(userId)
  const [editing, setEditing] = useState(false)

  const form = useForm({
    defaultValues: {
      fullName: legend?.fullName ?? '',
      dateOfBirth: legend?.dateOfBirth ?? '',
      address: legend?.address ?? '',
      hobbies: legend?.hobbies ?? '',
      notes: legend?.notes ?? '',
    },
    onSubmit: async ({ value }) => {
      const dto = upsertLegendSchema.parse({
        fullName: value.fullName,
        dateOfBirth: value.dateOfBirth || null,
        address: value.address || null,
        hobbies: value.hobbies || null,
        notes: value.notes || null,
      })
      await upsert.mutateAsync(dto)
      setEditing(false)
    },
  })

  // 403/400 — не показываем секцию вообще (ACCOUNTANT, DROP, etc.)
  const isForbidden =
    error &&
    typeof error === 'object' &&
    'response' in error &&
    ((error as { response?: { status?: number } }).response?.status === 403 ||
      (error as { response?: { status?: number } }).response?.status === 400)

  if (isForbidden) return null

  if (isLoading) {
    return (
      <Card data-testid="legend-section">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Легенда</CardTitle>
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
      hobbies: legend?.hobbies ?? '',
      notes: legend?.notes ?? '',
    })
    setEditing(true)
  }

  const handleCancel = () => {
    form.reset()
    setEditing(false)
  }

  // Read-only view
  if (!editing) {
    return (
      <Card data-testid="legend-section">
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-sm font-medium">Легенда</CardTitle>
          {canEdit && (
            <Button variant="ghost" size="sm" onClick={handleEdit} data-testid="legend-edit-button">
              <Pencil className="h-4 w-4 mr-1" />
              {legend ? 'Редактировать' : 'Создать'}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {!legend ? (
            <p className="text-sm text-muted-foreground">Легенда не заполнена</p>
          ) : (
            <dl className="space-y-2 text-sm" data-testid="legend-readonly">
              {legend.fullName && (
                <div>
                  <dt className="text-xs text-muted-foreground">ФИО</dt>
                  <dd className="font-medium" data-testid="legend-fullname">
                    {legend.fullName}
                  </dd>
                </div>
              )}
              {legend.dateOfBirth && (
                <div>
                  <dt className="text-xs text-muted-foreground">Дата рождения</dt>
                  <dd data-testid="legend-dob">{legend.dateOfBirth}</dd>
                </div>
              )}
              {legend.address && (
                <div>
                  <dt className="text-xs text-muted-foreground">Адрес</dt>
                  <dd data-testid="legend-address">{legend.address}</dd>
                </div>
              )}
              {legend.hobbies && (
                <div>
                  <dt className="text-xs text-muted-foreground">Хобби</dt>
                  <dd data-testid="legend-hobbies">{legend.hobbies}</dd>
                </div>
              )}
              {legend.notes && (
                <div>
                  <dt className="text-xs text-muted-foreground">Заметки</dt>
                  <dd className="whitespace-pre-wrap" data-testid="legend-notes">
                    {legend.notes}
                  </dd>
                </div>
              )}
            </dl>
          )}
        </CardContent>
      </Card>
    )
  }

  // Edit form (canEdit = true)
  return (
    <Card data-testid="legend-section">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-sm font-medium">Легенда</CardTitle>
        <Button variant="ghost" size="sm" onClick={handleCancel} data-testid="legend-cancel-button">
          <X className="h-4 w-4 mr-1" />
          Отмена
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
          <form.Field name="fullName">
            {(field) => (
              <div className="space-y-1">
                <Label htmlFor="legend-fullName">ФИО *</Label>
                <Input
                  id="legend-fullName"
                  data-testid="legend-input-fullname"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="Иванов Иван Иванович"
                />
                {field.state.meta.errors.length > 0 && (
                  <p className="text-xs text-destructive">{field.state.meta.errors[0]}</p>
                )}
              </div>
            )}
          </form.Field>

          <form.Field name="dateOfBirth">
            {(field) => (
              <div className="space-y-1">
                <Label htmlFor="legend-dateOfBirth">Дата рождения</Label>
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

          <form.Field name="address">
            {(field) => (
              <div className="space-y-1">
                <Label htmlFor="legend-address">Адрес</Label>
                <Input
                  id="legend-address"
                  data-testid="legend-input-address"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="Киев, ул. Крещатик 1"
                />
              </div>
            )}
          </form.Field>

          <form.Field name="hobbies">
            {(field) => (
              <div className="space-y-1">
                <Label htmlFor="legend-hobbies">Хобби</Label>
                <Input
                  id="legend-hobbies"
                  data-testid="legend-input-hobbies"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="Чтение, плавание..."
                />
              </div>
            )}
          </form.Field>

          <form.Field name="notes">
            {(field) => (
              <div className="space-y-1">
                <Label htmlFor="legend-notes">Заметки</Label>
                <Textarea
                  id="legend-notes"
                  data-testid="legend-input-notes"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="Дополнительная информация..."
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
              Отмена
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
              Сохранить
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
