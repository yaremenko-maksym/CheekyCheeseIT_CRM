import { Check, Plus, X } from 'lucide-react'
import { useState } from 'react'
import type { UserProfileDto } from '@crm/shared'
import { Trans, useLingui } from '@lingui/react/macro'
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { getInitials } from './constants'
import { Field } from './section'

/**
 * ut-16: Accountant as a single chip with an embedded inline dropdown (Command
 * inside a Popover). When the system has exactly one accountant the chip is
 * locked with a tooltip — mirrors the SOLO-HR treatment.
 *
 * Extracted from `UserDialog.tsx` to keep the dialog file under ~1300 lines
 * (Reviewer round 4 nit). Public props + all `data-testid` attributes are
 * preserved for E2E selectors.
 */
export function AccountantChipField({
  accountantUsers,
  selectedId,
  onChange,
  onlyAccountant,
}: {
  accountantUsers: UserProfileDto[]
  selectedId: string
  onChange: (next: string) => void
  onlyAccountant: boolean
}) {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const selected = accountantUsers.find((u) => u.id === selectedId) ?? null

  if (accountantUsers.length === 0) {
    return (
      <Field label={t`Бухгалтер`}>
        <p className="text-xs text-muted-foreground italic">
          <Trans>Немає вільних бухгалтерів — створіть бухгалтера у розділі «Команда»</Trans>
        </p>
      </Field>
    )
  }

  return (
    <Field label={t`Бухгалтер`}>
      <div className="flex flex-wrap items-center gap-2">
        {selected ? (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full bg-secondary py-0.5 pl-0.5 pr-2 text-sm',
                    onlyAccountant && 'cursor-default',
                  )}
                  data-testid="user-dialog-accountant-chip"
                >
                  <Avatar className="h-6 w-6">
                    {selected.avatarUrl ? (
                      <AvatarImage src={selected.avatarUrl} alt={selected.displayName} />
                    ) : null}
                    <AvatarFallback className="text-[10px]">
                      {getInitials(selected.displayName)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="leading-none">{selected.displayName}</span>
                  {!onlyAccountant ? (
                    <button
                      type="button"
                      onClick={() => onChange('')}
                      aria-label={t`Очистити бухгалтера`}
                      className="ml-0.5 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
                      data-testid="user-dialog-accountant-clear"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </span>
              </TooltipTrigger>
              {onlyAccountant ? (
                <TooltipContent>
                  <Trans>Єдиний бухгалтер у системі</Trans>
                </TooltipContent>
              ) : null}
            </Tooltip>
          </TooltipProvider>
        ) : null}

        {!selected || (!onlyAccountant && accountantUsers.length > 1) ? (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs"
                data-testid="user-dialog-accountant-trigger"
              >
                <Plus className="h-3.5 w-3.5" />
                {selected ? t`Змінити` : t`Обрати бухгалтера`}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-0" align="start">
              <Command>
                <CommandInput placeholder={t`Пошук за ім’ям або email…`} />
                <CommandList>
                  <CommandEmpty>
                    <Trans>Нічого не знайдено</Trans>
                  </CommandEmpty>
                  <CommandGroup>
                    {accountantUsers.map((u) => (
                      <CommandItem
                        key={u.id}
                        value={`${u.displayName} ${u.email}`}
                        onSelect={() => {
                          onChange(u.id)
                          setOpen(false)
                        }}
                        data-testid={`user-dialog-accountant-option-${u.id}`}
                      >
                        <Avatar className="h-6 w-6">
                          {u.avatarUrl ? (
                            <AvatarImage src={u.avatarUrl} alt={u.displayName} />
                          ) : null}
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
                        {u.id === selectedId ? (
                          <Check className="ml-auto h-4 w-4 text-primary" />
                        ) : null}
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
