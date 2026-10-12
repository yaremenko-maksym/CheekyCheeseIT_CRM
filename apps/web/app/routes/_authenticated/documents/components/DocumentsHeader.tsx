import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Plus } from 'lucide-react'
import { Trans } from '@lingui/react/macro'
import type { DocumentCategory, ProjectDto, SessionUser, UserProfileDto } from '@crm/shared'
import { api } from '@/lib/axios'
import { Button } from '@/components/ui/button'
import { UploadDocumentDialog } from '@/components/documents/upload-document-dialog'
import { UPLOADABLE_PER_ROLE, canSeeOwnerFilter } from '../constants'
import type { CategoryFilter } from '../types'

interface HeaderProps {
  viewer: SessionUser
  categoryFilter: CategoryFilter
  users: UserProfileDto[] | undefined
}

export function DocumentsHeader({ viewer, categoryFilter, users }: HeaderProps) {
  const showOwnerFilter = canSeeOwnerFilter(viewer.role)
  // Hide the upload button when viewing read-only category filters
  // (RECEIPT / INVOICE) — both are produced by Finance, not by uploads.
  const isReceiptsFilter = categoryFilter === 'RECEIPT'
  const isInvoicesFilter = categoryFilter === 'INVOICE'

  const [uploadOpen, setUploadOpen] = useState(false)

  // Projects — only needed for CONTRACT uploads.
  const { data: projects } = useQuery<ProjectDto[]>({
    queryKey: ['projects', { archived: 'active' }],
    queryFn: async () => {
      const res = await api.get<ProjectDto[]>('/projects')
      return res.data
    },
    enabled: uploadOpen,
    staleTime: 5 * 60 * 1000,
  })

  const uploadableCats = UPLOADABLE_PER_ROLE[viewer.role] ?? []
  // The upload button is hidden when:
  //   - the role can't upload anything from this page (e.g. ACCOUNTANT), OR
  //   - the dropdown is narrowed to Receipts only (uploads via Finance), OR
  //   - the dropdown is narrowed to an internal category (AVATAR/LOGO —
  //     managed in Profile/Project, not bulk-uploaded here).
  const canShowUploadButton =
    uploadableCats.length > 0 &&
    !isReceiptsFilter &&
    !isInvoicesFilter &&
    categoryFilter !== 'AVATAR' &&
    categoryFilter !== 'LOGO'

  // For the dialog we pick a sensible default category from the active
  // filter — fall back to the first uploadable category if the user is on
  // 'ALL' or a filter they can't upload to (e.g. ADMIN on RECEIPT).
  const defaultUploadCategory: DocumentCategory =
    categoryFilter !== 'ALL' && uploadableCats.includes(categoryFilter)
      ? categoryFilter
      : (uploadableCats[0] ?? 'RESUME')

  return (
    <>
      {/* Page header — mirrors /users: motion entrance, title on the left,
          primary action on the right. */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28 }}
        className="flex flex-wrap items-center justify-between gap-4"
      >
        <div />

        {canShowUploadButton ? (
          <Button onClick={() => setUploadOpen(true)} data-testid="documents-upload-button">
            <Plus className="mr-2 h-4 w-4" />
            {/* "Завантажити файл" (not bare "Завантажити") — the latter's
                msgid is already claimed catalog-wide by "Download"
                (ResumePreviewDialog.tsx); reusing the existing, unambiguous
                "Upload a file" entry (ResumeIntake.tsx) instead of adding a
                same-text-different-meaning collision (caught visually via
                screenshot review, not by any automated gate). */}
            <Trans>Завантажити файл</Trans>
          </Button>
        ) : null}
      </motion.div>

      {canShowUploadButton ? (
        <UploadDocumentDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          defaultCategory={defaultUploadCategory}
          allowedCategories={uploadableCats}
          projects={(projects ?? []).map((p) => ({
            id: p.id,
            label: `${p.companyName}${p.domain ? ' — ' + p.domain : ''}`,
          }))}
          owners={
            showOwnerFilter && users
              ? users.map((u) => ({
                  id: u.id,
                  label: `${u.displayName} (${u.email})`,
                }))
              : undefined
          }
          defaultOwnerId={viewer.id}
        />
      ) : null}
    </>
  )
}
