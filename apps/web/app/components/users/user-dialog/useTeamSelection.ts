import { useEffect, useRef, useState } from 'react'
import type { TeamDto, UserProfileDto } from '@crm/shared'

/** The slice of the TanStack form this hook writes to. */
type TeamChannelForm = {
  setFieldValue: (field: 'teamTelegramChannel', value: string) => void
}

type UseTeamSelectionArgs = {
  editingUser: UserProfileDto | null
  allTeams: TeamDto[] | undefined
  hrUsers: UserProfileDto[]
  accountantUsers: UserProfileDto[]
  isCreate: boolean
  isEdit: boolean
  open: boolean
}

/**
 * SENIOR/DROP team controls for UserDialog: the HR multiselect + Accountant
 * selection state, the inline HR error, the stale-closure refs read by the
 * parent's onSubmit, and the effect that seeds all of it (create defaults /
 * edit-from-active-team).
 */
export function useTeamSelection(
  form: TeamChannelForm,
  { editingUser, allTeams, hrUsers, accountantUsers, isCreate, isEdit, open }: UseTeamSelectionArgs,
) {
  // SENIOR-only team controls (HR multiselect + Accountant)
  const [selectedHrIds, setSelectedHrIds] = useState<string[]>([])
  const [selectedAccountantId, setSelectedAccountantId] = useState<string>('')
  // Drop role - phase 1 fix (AC6): inline validation error shown under the
  // HR multiselect. Set when submit fails the «HR ≥ 1» guard; cleared as
  // soon as the user adds an HR (handled via `handleHrChange` below) so the
  // red error message doesn't linger after the user fixed the issue.
  const [hrError, setHrError] = useState<string | undefined>(undefined)
  // Wrapping setter so we clear the error optimistically when the user
  // edits the selection — matches `touched` semantics in TanStack Form.
  const handleHrChange = (next: string[]) => {
    setSelectedHrIds(next)
    if (hrError && next.length > 0) setHrError(undefined)
  }

  // Refs to avoid stale-closure in onSubmit
  const selectedHrIdsRef = useRef(selectedHrIds)
  const selectedAccountantIdRef = useRef(selectedAccountantId)
  useEffect(() => {
    selectedHrIdsRef.current = selectedHrIds
  }, [selectedHrIds])
  useEffect(() => {
    selectedAccountantIdRef.current = selectedAccountantId
  }, [selectedAccountantId])

  /**
   * Senior's team is the team where the senior is an active member with role=SENIOR.
   * Existing HR/Accountant in that team (with leftAt=NULL) seed selections.
   * Also seeds `teamTelegramChannel` from the team row (ut-17).
   */
  useEffect(() => {
    if (isEdit && editingUser && editingUser.role === 'SENIOR' && allTeams) {
      const seniorsTeam = allTeams.find((t) =>
        t.members.some((m) => m.userId === editingUser.id && m.role === 'SENIOR' && !m.leftAt),
      )
      if (seniorsTeam) {
        const activeHrIds = seniorsTeam.members
          .filter((m) => m.role === 'HR' && !m.leftAt)
          .map((m) => m.userId)
        const activeAccountant = seniorsTeam.members.find(
          (m) => m.role === 'ACCOUNTANT' && !m.leftAt,
        )
        setSelectedHrIds(activeHrIds)
        setSelectedAccountantId(activeAccountant?.userId ?? '')
        form.setFieldValue('teamTelegramChannel', seniorsTeam.telegramChannel ?? '')
      } else {
        setSelectedHrIds([])
        setSelectedAccountantId('')
        form.setFieldValue('teamTelegramChannel', '')
      }
    } else if (isCreate && open) {
      // For CREATE: defaults — pre-select if only one option exists
      const initial = hrUsers.length === 1 && hrUsers[0] ? [hrUsers[0].id] : []
      setSelectedHrIds(initial)
      const accInitial =
        accountantUsers.length === 1 && accountantUsers[0] ? accountantUsers[0].id : ''
      setSelectedAccountantId(accInitial)
    }
    // form is stable but we intentionally exclude it from deps — re-running on
    // every form-state change would clobber edits in progress.
  }, [allTeams, editingUser?.id, hrUsers.length, accountantUsers.length, isEdit, isCreate, open])

  return {
    selectedHrIds,
    selectedAccountantId,
    setSelectedAccountantId,
    hrError,
    setHrError,
    handleHrChange,
    selectedHrIdsRef,
    selectedAccountantIdRef,
  }
}
