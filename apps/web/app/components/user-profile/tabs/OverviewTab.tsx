import type { UserProfileDto } from '@crm/shared'

export interface OverviewTabProps {
  user: UserProfileDto
  data: Record<string, unknown>
  mode: 'self' | 'view'
}

export function OverviewTab(_props: OverviewTabProps) {
  return <div>Overview (TODO)</div>
}
