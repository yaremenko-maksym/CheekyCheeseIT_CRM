/**
 * Experience section editor (task-resume-base §3).
 *
 * Order is a first-class feature here — the follow-up task
 * (task-resume-tailoring) reorders exactly these items per vacancy, so the base
 * editor has to make the order explicit and stable.
 *
 * Reordering uses up/down BUTTONS rather than drag-and-drop, deliberately:
 *   - it is keyboard- and screen-reader-operable for free, whereas a DnD list
 *     needs a whole parallel keyboard implementation to be accessible;
 *   - dragging inside a scrolling column on a phone fights the scroll gesture,
 *     and this screen must work at 320px (AC9);
 *   - the repo already paid for DnD flakiness once — the interviews kanban CI
 *     flake (#290) was a dnd-kit keyboard-DnD race. Buttons have no race.
 */
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import type { ResumeExperienceItem } from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

interface ResumeExperienceEditorProps {
  items: ResumeExperienceItem[]
  onChange: (items: ResumeExperienceItem[]) => void
}

export const EMPTY_EXPERIENCE_ITEM: ResumeExperienceItem = {
  company: '',
  role: '',
  period: '',
  bullets: [],
}

/** Pure move helper — exported so the reorder rule is unit-testable. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return [...items]
  }
  const next = [...items]
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return [...items]
  next.splice(to, 0, moved)
  return next
}

export function ResumeExperienceEditor({ items, onChange }: ResumeExperienceEditorProps) {
  function patch(index: number, changes: Partial<ResumeExperienceItem>) {
    onChange(items.map((item, i) => (i === index ? { ...item, ...changes } : item)))
  }

  return (
    <div className="space-y-4">
      {items.map((item, index) => (
        <div
          key={index}
          className="space-y-2 rounded-md border bg-muted/20 p-3"
          data-testid={`resume-experience-item-${index}`}
        >
          <div className="flex items-start justify-between gap-2">
            <p className="pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Место работы {index + 1}
            </p>
            <div className="flex shrink-0 gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onChange(moveItem(items, index, index - 1))}
                disabled={index === 0}
                aria-label={`Переместить место работы ${index + 1} вверх`}
                data-testid={`resume-experience-up-${index}`}
                className="h-11 w-11 sm:h-9 sm:w-9"
              >
                <ArrowUp className="h-4 w-4" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onChange(moveItem(items, index, index + 1))}
                disabled={index === items.length - 1}
                aria-label={`Переместить место работы ${index + 1} вниз`}
                data-testid={`resume-experience-down-${index}`}
                className="h-11 w-11 sm:h-9 sm:w-9"
              >
                <ArrowDown className="h-4 w-4" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onChange(items.filter((_, i) => i !== index))}
                aria-label={`Удалить место работы ${index + 1}`}
                data-testid={`resume-experience-remove-${index}`}
                className="h-11 w-11 text-destructive sm:h-9 sm:w-9"
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              value={item.role}
              onChange={(e) => patch(index, { role: e.target.value })}
              placeholder="Должность"
              aria-label={`Должность, место работы ${index + 1}`}
              data-testid={`resume-experience-role-${index}`}
            />
            <Input
              value={item.company}
              onChange={(e) => patch(index, { company: e.target.value })}
              placeholder="Компания"
              aria-label={`Компания, место работы ${index + 1}`}
              data-testid={`resume-experience-company-${index}`}
            />
          </div>
          <Input
            value={item.period}
            onChange={(e) => patch(index, { period: e.target.value })}
            placeholder="Период, например 2021 — наст. время"
            aria-label={`Период, место работы ${index + 1}`}
            data-testid={`resume-experience-period-${index}`}
          />
          <Textarea
            value={item.bullets.join('\n')}
            onChange={(e) =>
              patch(index, {
                // One achievement per line — the simplest editing model that
                // still maps 1:1 onto the stored array.
                bullets: e.target.value.split('\n'),
              })
            }
            placeholder="Достижения — по одному в строке"
            rows={4}
            aria-label={`Достижения, место работы ${index + 1}`}
            data-testid={`resume-experience-bullets-${index}`}
          />
        </div>
      ))}

      <Button
        variant="outline"
        onClick={() => onChange([...items, { ...EMPTY_EXPERIENCE_ITEM }])}
        data-testid="resume-experience-add"
        className="min-h-11 w-full sm:w-auto"
      >
        <Plus className="mr-2 h-4 w-4" aria-hidden />
        Добавить место работы
      </Button>
    </div>
  )
}
