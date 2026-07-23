/**
 * careersUrl — task-google-indexing-api.
 *
 * Builds the canonical public URL of a vacancy's careers page — the exact
 * URL sent to the Google Indexing API (GoogleIndexingService.notifyUpdated /
 * notifyDeleted) so Google associates the notification with the right
 * JobPosting page.
 *
 * The trailing slash is REQUIRED: apps/landing canonicalizes
 * `/careers/<slug>/` (see docs/design/crm-vacancies.md); sending Google a
 * URL without it would notify about a different, redirecting URL and the
 * indexing signal would not attach to the canonical page.
 *
 * Shared by VacanciesService (publish/close/slug-change hooks) and
 * VacanciesRetentionCronService (weekly PUBLISHED refresh) — kept as one
 * pure, trivially-testable function so both call sites stay in sync.
 */
export function careersUrl(origin: string, slug: string): string {
  return `${origin.replace(/\/+$/, '')}/careers/${slug}/`
}
