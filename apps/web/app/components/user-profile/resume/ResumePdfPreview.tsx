/**
 * ResumePdfPreview — the finished PDF, shown and downloadable.
 *
 * The PDF is produced by a background job, so this component renders THREE
 * honest states rather than a spinner that might never end:
 *   - up to date  -> the document, inline, plus a download link;
 *   - being built -> a named, explained wait (the query polls, no reload);
 *   - failed      -> the server's own Russian message, not "что-то пошло не так".
 *
 * "Up to date" is a fingerprint comparison done on the server (`pdfUpToDate`),
 * not "a render finished at some point". A PDF of yesterday's text is not the
 * current resume, and offering it as one is worse than offering nothing.
 *
 * Rendering is delegated to the shared `PdfPreview`, fed a BLOB URL from
 * `useResumePdfBlob`. Pointing a viewer straight at `/resume/pdf` shows nothing
 * at all: that route answers `Content-Disposition: attachment`, so the embedded
 * frame stays blank at every width and in both themes while the element sits
 * there looking correct. `PdfPreview` also brings the iframe/`<object>`
 * progressive fallback and the "browser blocked it" escape hatch, which a
 * hand-rolled `<object>` here did not.
 */
import { Download, FileText, Loader2, TriangleAlert } from 'lucide-react'
import type { SeniorResumeDto } from '@crm/shared'
import { Button } from '@/components/ui/button'
import { PdfPreview } from '@/components/documents/pdf-preview'
import { useResumePdfBlob } from '@/hooks/use-senior-resume'

export interface ResumePdfPreviewProps {
  resume: SeniorResumeDto
  pdfUrl: string
  /** Owner's display name, for the download filename. */
  fileName?: string
}

export function ResumePdfPreview({ resume, pdfUrl, fileName }: ResumePdfPreviewProps) {
  // Fetched only when the stored PDF matches the current resume — a stale one
  // must never be shown, so there is nothing to load until it is fresh.
  const { blobUrl, isLoading, hasError } = useResumePdfBlob(
    resume.userId,
    resume.pdfUpToDate,
    // The version moves on every content/layout/template change, so it is the
    // signal that a NEW document exists to fetch.
    `${resume.version}:${String(resume.pdfUpToDate)}`,
  )
  if (resume.renderStatus === 'FAILED' && !resume.pdfUpToDate) {
    return (
      <section
        data-testid="resume-pdf-failed"
        // AMBER, matching ResumeStatusPanel's extraction failure — not the
        // destructive red this used to be. Both panels say the same thing
        // ("this attempt did not work, the resume is fine, try again"), and two
        // colour languages for one meaning read as two different severities.
        // Red belongs to irreversible actions here, e.g. erasing a resume.
        className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4"
      >
        <div className="flex items-start gap-3">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <div className="text-sm">
            <p className="font-medium">Не удалось собрать PDF</p>
            <p className="mt-1 text-muted-foreground">
              {resume.renderError ??
                'Вёрстка резюме не собралась. Измените оформление или обратитесь к администратору.'}
            </p>
          </div>
        </div>
      </section>
    )
  }

  if (!resume.pdfUpToDate) {
    return (
      <section
        data-testid="resume-pdf-pending"
        className="rounded-xl border border-border/60 bg-card/50 p-6 text-center"
      >
        <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        <p className="mt-3 text-sm font-medium">Готовим PDF по шаблону</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Вёрстка собирается в фоне — страницу обновлять не нужно.
        </p>
      </section>
    )
  }

  return (
    <section data-testid="resume-pdf-preview" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium">
          <FileText className="size-4 text-muted-foreground" />
          Предпросмотр
        </p>
        <Button asChild size="sm" variant="outline">
          {/* A plain link, not a post-await window.open — mobile blocks those.
              This one WANTS the attachment header, which is why the endpoint
              keeps it and the viewer above goes through a blob instead. */}
          <a href={pdfUrl} download data-testid="resume-download-pdf">
            <Download className="mr-1.5 size-3.5" />
            Скачать PDF
          </a>
        </Button>
      </div>

      {/* Tall enough to read a page on a laptop, capped so the panel does not
          push the editing controls off a phone screen entirely. */}
      <PdfPreview
        blobUrl={blobUrl}
        isLoading={isLoading}
        hasError={hasError}
        filename={`Резюме — ${fileName ?? 'резюме'}.pdf`}
        className="h-[60vh] max-h-[840px] min-h-[320px]"
        testId="resume-pdf-object"
      />
    </section>
  )
}
