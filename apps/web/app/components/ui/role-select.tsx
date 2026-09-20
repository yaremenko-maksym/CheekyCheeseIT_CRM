import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { useLingui } from '@lingui/react/macro'
import type { Role } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// task-i18n-stage3a (Task 1), Step 1/2 — legacy export, LEFT UNCHANGED
// (still a plain `Record<Role, string>`, still Russian): eight consumers
// outside this wave's perimeter (`components/user-profile/**`,
// `components/users/**`, several `routes/_authenticated/**` outside the
// shell) render `{ROLE_LABELS[role]}` as a JSX child directly — swapping
// the type here to `MessageDescriptor` would fail typecheck on all eight
// and, where it doesn't, render `[object Object]`. `ROLE_LABEL_MESSAGES` +
// `useRoleLabel()` below are the new canon for consumers inside this wave's
// perimeter; the legacy export is removed once wave (b)/(c) migrate the
// remaining eight (see the plan's "Опасность: ROLE_LABELS").
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

/**
 * task-i18n-stage3a (Task 1), Step 1/2 — new canon. `msg` (module level,
 * `@lingui/core/macro`) fixes each role's SOURCE (`uk`) text as a
 * `MessageDescriptor`, resolved against the ACTIVE catalog by
 * `useRoleLabel()` below — never called at module level with `t`/`plural`,
 * which would freeze the string at import time (Global Constraints).
 */
export const ROLE_LABEL_MESSAGES: Record<Role, MessageDescriptor> = {
  ADMIN: msg`Адміністратор`,
  SENIOR: msg`Синьйор`,
  JUNIOR: msg`Джун`,
  HR: msg`HR`,
  ACCOUNTANT: msg`Бухгалтер`,
  DROP: msg`Дроп`,
}

/** Resolves `ROLE_LABEL_MESSAGES[role]` against the active locale — re-renders on locale switch. */
export function useRoleLabel(role: Role): string {
  const { i18n } = useLingui()
  return i18n._(ROLE_LABEL_MESSAGES[role])
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
  ariaLabel,
}: RoleSelectProps) {
  const { t } = useLingui()
  const list = (roles ?? ALL_ROLES).filter((r) => !exclude?.includes(r))

  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v as Role)}
      {...(disabled !== undefined && { disabled })}
    >
      <SelectTrigger className={className} aria-label={ariaLabel ?? t`Роль`}>
        <SelectValue placeholder={placeholder}>
          {value && (
            <Badge variant={ROLE_BADGE_VARIANT[value]} className="text-[11px]">
              <RoleLabel role={value} />
            </Badge>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {list.map((r) => (
          <SelectItem key={r} value={r}>
            <div className="flex items-center gap-2">
              <Badge variant={ROLE_BADGE_VARIANT[r]} className="text-[11px]">
                <RoleLabel role={r} />
              </Badge>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Small wrapper so `useRoleLabel` (a hook) is called once per list item's own component, not inside a `.map()` callback body (Rules of Hooks). */
function RoleLabel({ role }: { role: Role }) {
  return <>{useRoleLabel(role)}</>
}
