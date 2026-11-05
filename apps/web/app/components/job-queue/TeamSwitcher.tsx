import { useLingui } from '@lingui/react/macro'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/** HR with several active teams picks whose queue to work (spec §4.2). One team — nothing to pick. */
export function TeamSwitcher({
  teams,
  value,
  onChange,
}: {
  teams: ReadonlyArray<{ id: string; name: string }>
  value: string
  onChange: (teamId: string) => void
}) {
  const { t } = useLingui()
  if (teams.length < 2) return null
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        data-testid="job-queue-team-switcher"
        aria-label={t`Команда`}
        className="min-h-11 w-full min-[560px]:w-auto min-[560px]:min-w-48"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {teams.map((team) => (
          <SelectItem key={team.id} value={team.id}>
            {team.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
