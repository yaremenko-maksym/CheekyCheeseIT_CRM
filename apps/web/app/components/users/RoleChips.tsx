import { useLingui } from '@lingui/react/macro'
import { TECHNICAL_ROLE_LABELS, type TechnicalRole } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export interface RoleChipsProps {
  roles: readonly TechnicalRole[]
  /** Show at most this many chips, then "+N"; the hidden labels stay in an sr-only span. */
  limit?: number
  className?: string
}

/**
 * A senior's technical roles as read-only chips (`docs/design/senior-roles-ui.md`).
 * Renders nothing for an empty list, so callers need no guard or wrapper.
 */
export function RoleChips({ roles, limit = roles.length, className }: RoleChipsProps) {
  const { i18n } = useLingui()
  if (roles.length === 0) return null
  const label = (role: TechnicalRole) => i18n._(TECHNICAL_ROLE_LABELS[role])
  const hidden = roles.slice(limit)
  // Stryker disable next-line StringLiteral: layout classes only; jsdom has no layout, so no test can observe them (checked visually at 320/1440)
  const listClassName = cn('flex flex-wrap gap-1', className)
  return (
    <ul className={listClassName} data-testid="role-chips">
      {roles.slice(0, limit).map((role) => (
        <li key={role} className="max-w-full">
          <Badge
            variant="outline"
            className="max-w-full rounded-md px-1.5 py-0 text-xs font-normal leading-snug [overflow-wrap:anywhere]"
            data-testid={`role-chip-${role}`}
          >
            {label(role)}
          </Badge>
        </li>
      ))}
      {hidden.length > 0 && (
        <li className="text-xs text-muted-foreground">
          <span aria-hidden="true" data-testid="role-chips-more">
            +{hidden.length}
          </span>
          <span className="sr-only" data-testid="role-chips-hidden">
            {hidden.map(label).join(', ')}
          </span>
        </li>
      )}
    </ul>
  )
}
