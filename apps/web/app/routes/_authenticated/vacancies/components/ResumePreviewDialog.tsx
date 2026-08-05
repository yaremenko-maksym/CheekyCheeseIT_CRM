/**
 * ResumePreviewDialog — task-candidate-card-resume (AC2). Modal PDF preview
 * for a vacancy application's resume, opened from CandidateCard's «Просмотр»
 * button.
 *
 * Reuses the SAME generic preview surface DocumentDetailDialog uses for
 * RESUME-category documents (`components/documents/pdf-preview.tsx`'s
 * `PdfPreview` — iframe + <object> progressive fallback, timeout-based
 * "browser blocked the embed" card) — no third preview implementation, per
 * the task's explicit instruction. Blob-fetch plumbing (presigned inline
 * URL -> fetch -> Blob) lives in `useApplicationResumeBlob`.
 *
 * Access: the presigned URL comes from `GET .../resume-preview-url`, which
 * walks the EXACT same ADMIN|HR guard as the download endpoint
 * (`ApplicationsService.getResumePreviewUrl` — see that method's doc
 * comment) — this dialog never fetches the resume through any other path.
 */
import { useState } from 'react'
import { Download, ExternalLink, FileWarning } from 'lucide-react'
import type { VacancyApplication } from '@crm/shared'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/crm-dialog'
import { PdfPreview } from '@/components/documents/pdf-preview'
import { useApplicationResumeBlob } from '@/hooks/use-resume-blob'
import { useApplicationResumeUrl } from '@/hooks/use-vacancies'

export interface ResumePreviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  vacancyId: string
  application: VacancyApplication
}

export function ResumePreviewDialog({
  open,
  onOpenChange,
  vacancyId,
  application,
}: ResumePreviewDialogProps) {
  const [isDownloading, setIsDownloading] = useState(false)
  const filename = `${application.fullName}.pdf`

  const { blobUrl, isLoading, hasError, isUnsupportedFormat } = useApplicationResumeBlob(
    vacancyId,
    application.id,
    open,
  )
  const resumeUrlQuery = useApplicationResumeUrl(vacancyId, application.id, { enabled: false })

  // Same mobile-safe download as CandidateCard's own button (AC1) — see
  // CandidateCard.tsx's handleDownload for the full popup-blocking rationale.
  async function handleDownload() {
    setIsDownloading(true)
    try {
      const result = await resumeUrlQuery.refetch()
      const url = result.data?.url
      if (!url) return
      window.location.href = url
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <CrmDialogContent maxWidth="sm:max-w-3xl" data-testid="resume-preview-dialog">
        <CrmDialogHeader>
          <DialogTitle data-testid="resume-preview-title" className="line-clamp-1 pr-8">
            Резюме — {application.fullName}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Предпросмотр резюме кандидата {application.fullName}
          </DialogDescription>
        </CrmDialogHeader>

        <CrmDialogBody className="pb-4">
          <div
            className="relative h-[60vh] max-h-[560px] min-h-[320px] w-full overflow-hidden rounded-xl border border-border bg-muted"
            data-testid="resume-preview-body"
          >
            {isUnsupportedFormat ? (
              // task §2 (AC2): honest — never blames "the browser doesn't
              // support this" (see #470, where that exact wording turned out
              // to be a site-policy block, not a browser limitation). This
              // branch means the file itself isn't inline-viewable here.
              <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
                <FileWarning className="h-16 w-16 text-muted-foreground/50" />
                <p className="text-sm">
                  Предпросмотр недоступен для этого формата файла — скачайте, чтобы открыть.
                </p>
              </div>
            ) : (
              <PdfPreview
                blobUrl={blobUrl}
                isLoading={isLoading}
                hasError={hasError}
                filename={filename}
                testId="candidate-resume-preview"
                className="h-full w-full"
              />
            )}
          </div>
        </CrmDialogBody>

        <CrmDialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="resume-preview-close"
          >
            Закрыть
          </Button>
          <Button
            onClick={() => void handleDownload()}
            disabled={isDownloading || resumeUrlQuery.isFetching}
            data-testid="resume-preview-download"
          >
            {isDownloading || resumeUrlQuery.isFetching ? (
              <ExternalLink className="mr-1.5 h-4 w-4 animate-pulse" />
            ) : (
              <Download className="mr-1.5 h-4 w-4" />
            )}
            Скачать
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
