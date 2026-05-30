import type { Role } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Администратор',
  SENIOR: 'Синьор',
  JUNIOR: 'Джун',
  HR: 'HR',
  ACCOUNTANT: 'Бухгалтер',
  // Drop role - phase 1 (backend). UI polish ships in the frontend task —
  // until then we reuse the accountant variant so the badge renders without
  // a dedicated color.
  DROP: 'Дроп',
}

export const ROLE_BADGE_VARIANT: Record<Role, 'admin' | 'senior' | 'junior' | 'hr' | 'accountant'> =
  {
    ADMIN: 'admin',
    SENIOR: 'senior',
    JUNIOR: 'junior',
    HR: 'hr',
    ACCOUNTANT: 'accountant',
    // See ROLE_LABELS — placeholder until the frontend task picks the brand color.
    DROP: 'accountant',
  }

const ALL_ROLES: Role[] = ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']

export interface RoleSelectProps {
  value: Role
  onChange: (value: Role) => void
  /** Roles to exclude from the dropdown. Use to hide ADMIN when needed. */
  exclude?: Role[]
  /** Optional roles list — overrides the default if you need a tighter set. */
  roles?: Role[]
  disabled?: boolean
  className?: string
  placeholder?: string
  /** Optional aria-label for the trigger button (defaults to 'Роль'). */
  ariaLabel?: string
}

/**
 * Colored role picker — each option renders the role's `Badge` variant
 * (yellow = ADMIN, blue = SENIOR, green = JUNIOR, purple = HR, brown/orange =
 * ACCOUNTANT) so the picker matches the badge styling used everywhere else
 * in the CRM. Shared between admin dialogs and user-create forms.
 */
export function RoleSelect({
  value,
  onChange,
  exclude,
  roles,
  disabled,
  className,
  placeholder,
  ariaLabel = 'Роль',
}: RoleSelectProps) {
  const list = (roles ?? ALL_ROLES).filter((r) => !exclude?.includes(r))

  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v as Role)}
      {...(disabled !== undefined && { disabled })}
    >
      <SelectTrigger className={className} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder}>
          {value && (
            <Badge variant={ROLE_BADGE_VARIANT[value]} className="text-[11px]">
              {ROLE_LABELS[value]}
            </Badge>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {list.map((r) => (
          <SelectItem key={r} value={r}>
            <div className="flex items-center gap-2">
              <Badge variant={ROLE_BADGE_VARIANT[r]} className="text-[11px]">
                {ROLE_LABELS[r]}
              </Badge>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
