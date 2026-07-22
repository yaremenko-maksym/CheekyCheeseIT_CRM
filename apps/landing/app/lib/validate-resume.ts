/**
 * Client-side CV validation — same rules the server enforces
 * (apps/api/src/vacancies/applications.service.ts RESUME_MAX_BYTES + PDF
 * MIME check), so the UX catches the error before a submit round-trip
 * (docs/design/landing-redesign.md §2.4 CvDropzone). Shared by both the
 * `<input type=file>` change handler and the drag&drop handler.
 */
export const RESUME_MAX_BYTES = 5 * 1024 * 1024

export function validateResumeFile(file: File): string | null {
  const isPdfMime = file.type === 'application/pdf'
  const isPdfExt = /\.pdf$/i.test(file.name)
  if (!isPdfMime && !isPdfExt) return 'CV must be a PDF file.'
  if (file.size > RESUME_MAX_BYTES) return 'File is larger than 5 MB.'
  return null
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1_048_576).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}
