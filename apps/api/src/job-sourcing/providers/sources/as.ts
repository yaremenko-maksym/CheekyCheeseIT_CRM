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

export const positiveSafeInt = () => z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)

/** A date as the wire carries it; the date policy decides what it means. */
export const dateRaw = () =>
  z
    .union([z.string().max(DATE_RAW_MAX_CHARS), z.number()])
    .nullish()
    .transform((v) => v ?? null)

export const boundedStringArray = (maxItems: number, maxChars: number) =>
  z.array(z.string().max(maxChars)).max(maxItems)
