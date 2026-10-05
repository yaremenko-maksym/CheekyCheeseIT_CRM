import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLingui } from '@lingui/react/macro'
import { toast } from 'sonner'
import type { ProjectDto } from '@crm/shared'
import { api } from '@/lib/axios'
import { getApiErrorMessage } from '@/lib/axios-utils'

/**
 * Drop attach/detach mutation for the project-detail page. Moved verbatim from
 * `$projectId.tsx`; the page passes `onSuccessClose` to keep closing its two
 * dialogs (picker + detach-confirm) exactly where the inline `onSuccess` did.
 * Must be called unconditionally, before the page's `denied` early-return.
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
