import { Plus, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { UserProfileDto } from '@crm/shared'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { getInitials } from './constants'
import { Field } from './section'

/**
 * ut-16: HR multiselect rendered as removable chips + a searchable "Add HR"
 * popover. Each chip shows avatar + name + remove (×). When only one HR
 * exists in the system the chip is auto-selected, non-removable, and shows
 * a tooltip explaining why.
 *
 * Extracted from `UserDialog.tsx` to keep the dialog file under ~1300 lines
 * (Reviewer round 4 nit). Public props + all `data-testid` attributes are
 * preserved for E2E selectors.
 */
export function HrChipsField({
  hrUsers,
  selectedIds,
  onChange,
  required,
  onlyHr,
}: {
  hrUsers: UserProfileDto[]
  selectedIds: string[]
  onChange: (next: string[]) => void
  required: boolean
  onlyHr: boolean
}) {
  const [open, setOpen] = useState(false)

  const selected = useMemo(
    () => selectedIds
      .map((id) => hrUsers.find((u) => u.id === id))
      .filter((u): u is UserProfileDto => !!u),
    [selectedIds, hrUsers],
  )
  const available = useMemo(
    () => hrUsers.filter((u) => !selectedIds.includes(u.id)),
    [hrUsers, selectedIds],
  )

  if (hrUsers.length === 0) {
    return (
      <Field label="HR" required={required}>
        <p className="text-xs text-muted-foreground italic">Нет доступных HR</p>
      </Field>
    )
  }

  return (
    <Field label={`HR${selected.length > 0 ? ` (${selected.length} выбрано)` : ''}`} required={required}>
      <div className="space-y-2" data-testid="user-dialog-hr-multiselect">
        <div className="flex flex-wrap gap-1.5">
          {selected.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">Никто не выбран</p>
          ) : (
            selected.map((u) => {
              const locked = onlyHr
              return (
                <TooltipProvider key={u.id} delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className={cn(
                          'group inline-flex items-center gap-1.5 rounded-full bg-secondary py-0.5 pl-0.5 pr-2 text-sm',
                          locked && 'cursor-default',
                        )}
                        data-testid={`user-dialog-hr-chip-${u.id}`}
                      >
                        <Avatar className="h-6 w-6">
                          {u.avatarUrl ? <AvatarImage src={u.avatarUrl} alt={u.displayName} /> : null}
                          <AvatarFallback className="text-[10px]">
                            {getInitials(u.displayName)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="leading-none">{u.displayName}</span>
                        {!locked ? (
                          <button
                            type="button"
                            onClick={() => onChange(selectedIds.filter((id) => id !== u.id))}
                            aria-label={`Удалить ${u.displayName}`}
                            className="ml-0.5 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
                            data-testid={`user-dialog-hr-remove-${u.id}`}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        ) : null}
                      </span>
                    </TooltipTrigger>
                    {locked ? (
                      <TooltipContent>Единственный HR в системе</TooltipContent>
                    ) : null}
                  </Tooltip>
                </TooltipProvider>
              )
            })
          )}
        </div>

        {available.length > 0 ? (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs"
                data-testid="user-dialog-hr-add-trigger"
              >
                <Plus className="h-3.5 w-3.5" /> Добавить HR
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-0" align="start">
              <Command>
                <CommandInput placeholder="Поиск по имени или email…" />
                <CommandList>
                  <CommandEmpty>Не найдено</CommandEmpty>
                  <CommandGroup>
                    {available.map((u) => (
                      <CommandItem
                        key={u.id}
                        value={`${u.displayName} ${u.email}`}
                        onSelect={() => {
                          onChange([...selectedIds, u.id])
                          setOpen(false)
                        }}
                        data-testid={`user-dialog-hr-option-${u.id}`}
                      >
                        <Avatar className="h-6 w-6">
                          {u.avatarUrl ? <AvatarImage src={u.avatarUrl} alt={u.displayName} /> : null}
                          <AvatarFallback className="text-[10px]">
                            {getInitials(u.displayName)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex flex-col">
                          <span className="text-sm leading-tight">{u.displayName}</span>
                          <span className="text-xs text-muted-foreground leading-tight">
                            {u.email}
                          </span>
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
    </Field>
  )
}
