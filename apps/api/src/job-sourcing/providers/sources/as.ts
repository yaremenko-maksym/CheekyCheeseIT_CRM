import { z } from 'zod'
import { MAX_LINK_CHARS } from '../../normalize/url-policy'

/**
 * Bounded field helpers for the phase-3 JSON adapters' item schemas.
 *
 * Every helper REFUSES past its bound (the item becomes an isolated invalid sample) rather than
 * cutting: a silent cut would hide that the provider sent something abnormal. The shipped
 * normalizer applies its own retention caps afterwards, so these bounds are the outer fence, not
 * the display limit. Absent optional values collapse to `null`, so a mapper never distinguishes
 * "missing" from "null". URL safety (credentials, hosts) is NOT judged here: the observation
 * builder owns that verdict and reports it as a quarantine reason.
 */

/** A raw date string is a wire value like `2026-10-22T12:58:28+00:00`; far longer is not a date. */
export const DATE_RAW_MAX_CHARS = 64

export const boundedString = (max: number) => z.string().max(max)

export const optionalString = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => v ?? null)

export const urlString = () => z.string().max(MAX_LINK_CHARS)

export const optionalUrlString = () => optionalString(MAX_LINK_CHARS)

export const boundedNumber = (min: number, max: number) => z.number().min(min).max(max)

export const optionalBoundedNumber = (min: number, max: number) =>
  boundedNumber(min, max)
    .nullish()
    .transform((v) => v ?? null)

/**
 * A provider-issued numeric id. The safe-integer ceiling is carried by `.int()` itself (Zod v4
 * refuses integers past 2^53 - 1), so there is deliberately no `.max` here: it would be an
 * unreachable bound whose test could not fail for the reason it names.
 */
export const positiveSafeInt = () => z.number().int().min(1)

/** A date as the wire carries it; the date policy decides what it means. */
export const dateRaw = () =>
  z
    .union([z.string().max(DATE_RAW_MAX_CHARS), z.number()])
    .nullish()
    .transform((v) => v ?? null)

export const boundedStringArray = (maxItems: number, maxChars: number) =>
  z.array(z.string().max(maxChars)).max(maxItems)

/** A lowercase URL/filter slug: `a`, `data-science`, `x1-y2`. No separators, escapes or edge hyphens. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const slugString = (max: number) => z.string().min(1).max(max).regex(SLUG_PATTERN)

/** Like `boundedStringArray`, but an absent or null array is an empty one. */
export const optionalStringArray = (maxItems: number, maxChars: number) =>
  boundedStringArray(maxItems, maxChars)
    .nullish()
    .transform((v) => v ?? [])
