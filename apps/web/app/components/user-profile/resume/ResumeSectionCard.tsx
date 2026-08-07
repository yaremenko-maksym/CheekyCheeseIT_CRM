/**
 * One editable resume section (task-resume-base §3).
 *
 * The task is explicit that HR comfort is the point: the resume is edited IN
 * PLACE, section by section — never "open a modal and re-save everything".
 * So each section owns its own view/edit toggle and its own Save/Cancel, and a
 * save only ever touches that section's slice of the content.
 *
 * Unsaved work is protected two ways (the task forbids losing edits on
 * navigation): `onDirtyChange` bubbles up to the profile shell, which already
 * guards tab switches with a confirm dialog, and a `beforeunload` handler
 * covers a real browser navigation/close.
 */
import { useEffect, type ReactNode } from 'react'
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
  onStartEdit,
  onCancel,
  onSave,
  children,
}: ResumeSectionCardProps) {
  // Real browser navigation (reload / close / external link) — the in-app tab
  // switch is handled by the profile shell's confirm dialog.
  useEffect(() => {
    if (!isDirty) return undefined
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Chrome requires returnValue to be set for the native prompt to show.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  return (
    <Card data-testid={`resume-section-${sectionId}`}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        {canEdit && !isEditing && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onStartEdit}
            aria-label={`Редактировать раздел «${title}»`}
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
          <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:justify-end">
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
        )}
      </CardContent>
    </Card>
  )
}
