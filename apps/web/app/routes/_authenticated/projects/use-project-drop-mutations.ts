import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLingui } from '@lingui/react/macro'
import { toast } from 'sonner'
import type { ProjectDto } from '@crm/shared'
import { api } from '@/lib/axios'
import { getApiErrorMessage } from '@/lib/axios-utils'

/**
 * Drop attach/detach mutation for the project-detail page. Its only consumer is
 * `ProjectDropDialogs`, which passes `onSuccessClose` to close both of its dialogs
 * (picker + detach-confirm) after a successful attach/detach.
 */
export function useProjectDropMutations(projectId: string, onSuccessClose: () => void) {
  const { t } = useLingui()
  const qc = useQueryClient()

  // Drop mutation: PATCH /projects/:id { dropId } for attach (string) and detach (null)
  const dropMutation = useMutation({
    mutationFn: (dropId: string | null) =>
      api.patch<ProjectDto>(`/projects/${projectId}`, { dropId }).then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects', projectId] })
      void qc.invalidateQueries({ queryKey: ['projects'] })
      void qc.invalidateQueries({ queryKey: ['users'] })
      onSuccessClose()
    },
    onError: (err) => {
      toast.error(getApiErrorMessage(err, t`Не вдалося змінити дропа`))
    },
  })

  return { dropMutation }
}
