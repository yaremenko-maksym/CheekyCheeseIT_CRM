import { Plus, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  SENIOR_SELECTABLE_ROLES,
  TECHNICAL_ROLE_GROUPS,
  TECHNICAL_ROLE_GROUP_LABELS,
  TECHNICAL_ROLE_LABELS,
  sortRoles,
  type SeniorSelectableRole,
  type TechnicalRole,
} from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

const SELECTABLE = new Set<TechnicalRole>(SENIOR_SELECTABLE_ROLES)

export interface RolesSectionProps {
  value: readonly SeniorSelectableRole[]
  onChange: (next: SeniorSelectableRole[]) => void
  error?: string | undefined
  disabled?: boolean | undefined
  /** `alert` after a submit (dialogs); `status` while the user is still editing (self-edit). */
  announce?: 'alert' | 'status'
}

/**
 * A senior's technical roles: removable chips + a grouped, searchable "add" popover
 * (`docs/design/senior-roles-ui.md` §5). The caller owns the value and the error.
 */
export function RolesSection({
  value,
  onChange,
  error,
  disabled = false,
  announce = 'alert',
}: RolesSectionProps) {
  const { t, i18n } = useLingui()
  const labelId = useId()
  const errorId = useId()
  const baseId = useId()
  const triggerId = `${baseId}add`
  const removeId = (role: SeniorSelectableRole) => `${baseId}remove-${role}`
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  // The row that took a picked row's place; it wins over cmdk's reset to the first row.
  const pendingHighlight = useRef<string | undefined>(undefined)

  const label = (role: TechnicalRole) => i18n._(TECHNICAL_ROLE_LABELS[role])
  const selected = new Set<TechnicalRole>(value)
  const allSelected = value.length >= SENIOR_SELECTABLE_ROLES.length

  // A pick whose row cmdk did not highlight (a tap) gets no cmdk reset: apply the pending row here.
  // This runs BEFORE cmdk's `onValueChange` on the keyboard path, which still needs the ref to beat
  // the reset — so this consumer must not clear it. Instead every other way out of a pick clears it
  // (CR-L: on the tap path nobody did, and a later chip removal replayed the stale row).
  useEffect(() => {
    if (pendingHighlight.current !== undefined) setHighlight(pendingHighlight.current)
  }, [value])

  function add(role: SeniorSelectableRole, itemValue: string) {
    // DOM order is the visible order (cmdk sorts by score while searching).
    // Stryker disable next-line OptionalChaining,ArrayDeclaration: onSelect fires only from a mounted list, so the ref is always set
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[cmdk-item]') ?? [])]
    const at = rows.findIndex((row) => row.dataset['value'] === itemValue)
    pendingHighlight.current = (rows[at + 1] ?? rows[at - 1])?.dataset['value']
    setAnnouncement(t`Додано: ${label(role)}`)
    onChange(sortRoles([...value, role]))
  }

  function remove(role: SeniorSelectableRole) {
    // A removal is not a pick: no row to restore, and a pick's row is stale by now. The ref does
    // survive a tap-pick — cmdk emits no `onValueChange` when the list changes under it, measured, so
    // only the keyboard path consumes it — and without this line the `[value]` effect above would
    // replay that row on every later removal. The replay is unobservable today: the effect already
    // set `highlight` to that same row at the pick, and everything that moves the highlight afterwards
    // goes through `onValueChange`, which clears the ref. So it could only re-set the value already
    // there. Kept as the invariant (CR-L), not as a fix for a reachable bug.
    // Stryker disable next-line BlockStatement,ObjectLiteral: equivalent mutant — the replay this prevents can only re-set the current highlight (see above)
    pendingHighlight.current = undefined
    const at = value.indexOf(role)
    const next = value[at + 1] ?? value[at - 1]
    setAnnouncement(t`Прибрано: ${label(role)}`)
    // Commit now: the pressed button is gone, so focus goes to the next chip, else the previous, else
    // the trigger (which may only now reappear) — never to <body> (design spec §5.7).
    flushSync(() => onChange(value.filter((r) => r !== role)))
    // Stryker disable next-line OptionalChaining: the target is rendered by the commit above (a remaining chip, or the trigger once fewer than all roles are picked)
    document.getElementById(next ? removeId(next) : triggerId)?.focus()
  }

  return (
    <div className="grid gap-1.5">
      <Label id={labelId} className={cn(error && 'text-destructive')}>
        {value.length > 0 ? t`Технічні ролі (обрано: ${value.length})` : t`Технічні ролі`}
        <span className="text-destructive"> *</span>
      </Label>
      <div role="group" aria-labelledby={labelId} className="space-y-2" data-testid="roles-section">
        {!allSelected && (
          <Popover open={open && !disabled} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                id={triggerId}
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 gap-1 text-xs"
                disabled={disabled}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                data-testid="roles-section-add-trigger"
              >
                <Plus className="size-3.5" aria-hidden="true" /> <Trans>Додати роль</Trans>
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-[min(20rem,calc(100vw-2rem))] p-0"
              align="start"
              data-testid="roles-section-popover"
            >
              <Command
                value={highlight}
                onValueChange={(next) => {
                  // cmdk resets the highlight to the first row once the picked row unmounts; the
                  // row that took the picked row's place wins over that reset (design spec §5.5).
                  setHighlight(pendingHighlight.current ?? next)
                  pendingHighlight.current = undefined
                }}
              >
                <CommandInput placeholder={t`Пошук ролі…`} />
                <CommandList ref={listRef} className="max-h-[min(20rem,50dvh)]">
                  <CommandEmpty>
                    <Trans>Нічого не знайдено</Trans>
                  </CommandEmpty>
                  {TECHNICAL_ROLE_GROUPS.map((group) => {
                    const roles = group.roles.filter(
                      (r): r is SeniorSelectableRole => SELECTABLE.has(r) && !selected.has(r),
                    )
                    if (roles.length === 0) return null
                    const heading = i18n._(TECHNICAL_ROLE_GROUP_LABELS[group.id])
                    return (
                      <CommandGroup key={group.id} heading={heading}>
                        {roles.map((role) => (
                          <CommandItem
                            key={role}
                            value={label(role)}
                            keywords={[heading]}
                            onSelect={(v) => add(role, v)}
                            className="whitespace-normal leading-snug"
                            data-testid={`roles-section-option-${role}`}
                          >
                            {label(role)}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )
                  })}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        )}

        <div className="flex flex-wrap gap-1.5">
          {value.length === 0 ? (
            <p className="text-xs italic text-muted-foreground">
              <Trans>Нічого не обрано</Trans>
            </p>
          ) : (
            value.map((role) => (
              <Badge
                key={role}
                variant="outline"
                className="h-auto min-h-7 max-w-full items-center gap-1 rounded-md py-0.5 pl-2 pr-0.5 text-xs font-normal"
                data-testid={`roles-section-chip-${role}`}
              >
                <span className="min-w-0 leading-snug text-pretty [overflow-wrap:anywhere]">
                  {label(role)}
                </span>
                <button
                  id={removeId(role)}
                  type="button"
                  disabled={disabled}
                  onClick={() => remove(role)}
                  aria-label={t`Прибрати роль ${label(role)}`}
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-destructive/20 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                  data-testid={`roles-section-remove-${role}`}
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </Badge>
            ))
          )}
        </div>
      </div>
      {error && (
        <p
          id={errorId}
          role={announce}
          className="text-xs text-destructive"
          data-testid="roles-section-error"
        >
          {error}
        </p>
      )}
      <span role="status" className="sr-only">
        {announcement}
      </span>
    </div>
  )
}
