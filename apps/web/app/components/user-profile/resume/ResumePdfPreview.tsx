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
 * `<object>` rather than `<iframe>`: same-origin PDFs are allow-listed by the
 * site's `object-src 'self' blob:` (see main.ts), it degrades to its children
 * when a browser has no PDF viewer, and it is the pattern the finance receipt
 * panel already uses.
 */
import { Download, FileText, Loader2, TriangleAlert } from 'lucide-react'
import type { SeniorResumeDto } from '@crm/shared'
import { Button } from '@/components/ui/button'

export interface ResumePdfPreviewProps {
  resume: SeniorResumeDto
  pdfUrl: string
}

export function ResumePdfPreview({ resume, pdfUrl }: ResumePdfPreviewProps) {
  if (resume.renderStatus === 'FAILED' && !resume.pdfUpToDate) {
    return (
      <section
        data-testid="resume-pdf-failed"
        className="rounded-xl border border-destructive/40 bg-destructive/5 p-4"
      >
        <div className="flex items-start gap-3">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
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
          {/* A plain link, not a post-await window.open — mobile blocks those. */}
          <a href={pdfUrl} download data-testid="resume-download-pdf">
            <Download className="mr-1.5 size-3.5" />
            Скачать PDF
          </a>
        </Button>
      </div>

      <object
        data={pdfUrl}
        type="application/pdf"
        // Tall enough to read a page on a laptop, capped so the panel does not
        // push the editing controls off a phone screen entirely.
        className="h-[60vh] max-h-[840px] min-h-[320px] w-full rounded-xl border border-border/60 bg-muted/20"
        aria-label="Предпросмотр резюме в формате PDF"
        data-testid="resume-pdf-object"
      >
        {/* Shown when the browser has no inline PDF viewer — most phones. */}
        <div className="p-6 text-center text-sm text-muted-foreground">
          Предпросмотр недоступен в этом браузере.{' '}
          <a href={pdfUrl} download className="underline underline-offset-2">
            Скачайте PDF
          </a>
          .
        </div>
      </object>
    </section>
  )
}
