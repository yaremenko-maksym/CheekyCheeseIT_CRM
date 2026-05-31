/**
 * Phone field helpers.
 *
 * The `PhoneInput` component (react-phone-number-input) seeds the field with
 * the country calling code on first render — e.g. `+380` for UA — even if the
 * user never types any digits. As a result the DB ends up storing `+380`
 * (or another bare calling code) for users who left the field blank, and the
 * UI then renders a "phone" link that is just the country code with no
 * subscriber digits.
 *
 * `hasRealPhone` returns `true` only when the string contains at least one
 * digit beyond the leading `+<callingCode>`. Use it to gate phone rendering
 * in cards / profile headers / list rows so we don't show empty `tel:+380`
 * affordances.
 */

/** Common calling-code-only sentinels that should be treated as "no phone". */
const CALLING_CODE_ONLY = new Set<string>([
  '+',
  '+1',
  '+7',
  '+44',
  '+48',
  '+49',
  '+380', // UA (default in PhoneInput)
  '+420',
  '+421',
])

/**
 * Returns `true` only when `phone` looks like a real number (more than just
 * a country calling code).
 *
 * Rules:
 *   - null / undefined / empty / whitespace-only → false
 *   - bare `+` or any value in CALLING_CODE_ONLY → false
 *   - shorter than 5 chars total (e.g. `+380`) → false
 *   - "+<digits>" where the digit count after `+` is below 6 → false
 *     (international subscriber numbers are at least 6 digits — anything
 *     shorter is almost certainly the calling code on its own)
 *   - everything else → true
 */
export function hasRealPhone(phone: string | null | undefined): boolean {
  if (!phone) return false
  const trimmed = phone.trim()
  if (trimmed.length === 0) return false
  if (CALLING_CODE_ONLY.has(trimmed)) return false
  if (trimmed.length <= 4) return false
  // Count actual digits — strip any non-digit chars (spaces, dashes, parens).
  const digits = trimmed.replace(/\D/g, '')
  // Calling codes are 1–3 digits; subscriber numbers are 6+ digits. If we
  // have fewer than 6 digits total it's effectively just the calling code.
  if (digits.length < 6) return false
  return true
}
