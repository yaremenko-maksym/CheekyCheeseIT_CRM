/**
 * Retry helpers shared by the Resend-backed mailers.
 *
 * Before extraction `PersonalEmailInviteMailerService` held private copies of
 * both helpers, `ContactService` of `sleep` only, and `NotificationEmailCron` of
 * `safeErrorReason` only. The contact form logged the raw provider message and
 * now adopts `safeErrorReason` too, so the PII rule below has exactly one
 * implementation to audit.
 */

/** Backoff between send attempts: resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The reason for failure WITHOUT the provider's response body.
 *
 * `ResendMailerService.send` throws an `Error` with the text `Resend API HTTP
 * <status>: <piece of body>`, and for a rejected address this piece quotes the address itself —
 * that is, exactly the data this project keeps out of logs, telemetry and
 * `last_error` columns. We keep the status (it shows "bad request" versus "provider
 * is down"); in other cases — the error class name.
 *
 * Never returns anything from `.message` itself beyond the extracted status.
 * Shared by notification mail, personal-email invites, and the contact form
 * (LOW-3, security-review PR #623).
 */
export function safeErrorReason(err: unknown): string {
  if (err instanceof Error) {
    const statusMatch = /^Resend API HTTP (\d+)/.exec(err.message)
    if (statusMatch) return `Resend API HTTP ${statusMatch[1]}`
    return err.constructor.name
  }
  return 'unknown'
}
