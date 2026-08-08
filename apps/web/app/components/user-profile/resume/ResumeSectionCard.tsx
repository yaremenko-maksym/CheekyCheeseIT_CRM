/**
 * One editable resume section (task-resume-base §3).
 *
 * The task is explicit that HR comfort is the point: the resume is edited IN
 * PLACE, section by section — never "open a modal and re-save everything".
 * So each section owns its own view/edit toggle and its own Save/Cancel, and a
 * save only ever touches that section's slice of the content.
 *
 * Unsaved work is protected three ways (the task forbids losing edits on
 * navigation): `onDirtyChange` bubbles up to the profile shell, which already
 * guards tab switches with a confirm dialog; ResumeTab owns a single
 * `beforeunload` handler for real browser navigation; and `disableEdit` below
 * closes the third route out — starting a DIFFERENT section while this one has
 * unsaved changes. Only ONE section is editable at a time, so no edit can be
 * silently discarded by a click somewhere else on the page.
 */
import type { ReactNode } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface ResumeSectionCardProps {
  title: string
  /** Stable id — drives testids so E2E can address a specific section. */
  sectionId: string
  canEdit: boolean
  isEditing: boolean
  isDirty: boolean
  isSaving: boolean
  /** True while ANOTHER section is open for editing — see the module doc. */
  disableEdit: boolean
  onStartEdit: () => void
  onCancel: () => void
  onSave: () => void
  children: ReactNode
}

export function ResumeSectionCard({
  title,
  sectionId,
  canEdit,
  isEditing,
  isDirty,
  isSaving,
  disableEdit,
  onStartEdit,
  onCancel,
  onSave,
  children,
}: ResumeSectionCardProps) {
  return (
    <Card data-testid={`resume-section-${sectionId}`}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        {canEdit && !isEditing && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onStartEdit}
            disabled={disableEdit}
            aria-label={`Редактировать раздел «${title}»`}
            title={
              disableEdit ? 'Сначала сохраните или отмените правки в открытом разделе' : undefined
            }
            data-testid={`resume-edit-${sectionId}`}
            className="min-h-11 shrink-0 sm:min-h-9"
          >
            <Pencil className="h-4 w-4" aria-hidden />
            <span className="ml-2 hidden sm:inline">Изменить</span>
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {children}
        {isEditing && (
          <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
            <p
              className="text-xs text-muted-foreground"
              data-testid={`resume-editing-hint-${sectionId}`}
            >
              {isDirty
                ? 'Есть несохранённые правки — остальные разделы недоступны, пока вы не сохраните или не отмените их.'
                : 'Остальные разделы недоступны, пока открыт этот.'}
            </p>
            <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:justify-end">
              <Button
                variant="ghost"
                onClick={onCancel}
                disabled={isSaving}
                data-testid={`resume-cancel-${sectionId}`}
                className="min-h-11"
              >
                <X className="mr-2 h-4 w-4" aria-hidden />
                Отмена
              </Button>
              <Button
                onClick={onSave}
                disabled={isSaving || !isDirty}
                data-testid={`resume-save-${sectionId}`}
                className="min-h-11"
              >
                <Check className="mr-2 h-4 w-4" aria-hidden />
                {isSaving ? 'Сохраняем…' : 'Сохранить'}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
