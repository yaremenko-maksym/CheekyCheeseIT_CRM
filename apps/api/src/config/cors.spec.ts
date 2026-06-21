import { describe, expect, it } from 'vitest'
import { parseCorsOrigins } from './cors'

/**
 * Unit tests for parseCorsOrigins — CORS origin allowlist builder.
 *
 * Security surface: determines which origins browsers are permitted to send
 * cross-origin requests from. Incorrect logic = either over-permissive CORS
 * (allows untrusted origins) or under-permissive (breaks prod CRM).
 *
 * Cases:
 *  1. CORS_ORIGINS provided → multi-origin exact allowlist (no tunnel regexes)
 *  2. CORS_ORIGINS not provided → fallback to [FRONTEND_URL]
 *  3. CORS_ORIGINS with whitespace/empty segments → trimmed + filtered
 *  4. NODE_ENV=production → dev-tunnel regexes NEVER included
 *  5. NODE_ENV=development + no CORS_ORIGINS → dev-tunnel regexes appended
 *  6. NODE_ENV=development + CORS_ORIGINS set → exact list only (no tunnel regexes)
 */

const FRONTEND_URL = 'http://localhost:3000'
const PROD_ORIGINS = 'https://app.cheekycheese.tech,https://cheekycheese.tech'

describe('parseCorsOrigins', () => {
  describe('CORS_ORIGINS provided', () => {
    it('returns exact origin array from comma-separated CORS_ORIGINS (production)', () => {
      const result = parseCorsOrigins({
        corsOrigins: PROD_ORIGINS,
        frontendUrl: FRONTEND_URL,
        isProduction: true,
      })

      expect(result).toEqual(['https://app.cheekycheese.tech', 'https://cheekycheese.tech'])
    })

    it('does NOT include dev-tunnel regexes even in non-production when CORS_ORIGINS is set', () => {
      const result = parseCorsOrigins({
        corsOrigins: PROD_ORIGINS,
        frontendUrl: FRONTEND_URL,
        isProduction: false,
      })

      // No RegExp entries — only the explicit origins
      expect(result.every((o) => typeof o === 'string')).toBe(true)
      expect(result).toEqual(['https://app.cheekycheese.tech', 'https://cheekycheese.tech'])
    })
  })

  describe('CORS_ORIGINS not provided (fallback)', () => {
    it('falls back to [FRONTEND_URL] in production (no tunnel regexes)', () => {
      const result = parseCorsOrigins({
        corsOrigins: undefined,
        frontendUrl: FRONTEND_URL,
        isProduction: true,
      })

      expect(result).toEqual([FRONTEND_URL])
      // No RegExp in production
      expect(result.every((o) => typeof o === 'string')).toBe(true)
    })

    it('falls back to [FRONTEND_URL] + dev-tunnel regexes in development', () => {
      const result = parseCorsOrigins({
        corsOrigins: undefined,
        frontendUrl: FRONTEND_URL,
        isProduction: false,
      })

      expect(result).toContain(FRONTEND_URL)
      // Must include the dev-tunnel regexes — test the regex against known tunnel hostnames
      const hasServeoNet = result.some((o) => o instanceof RegExp && o.test('tunnel.serveo.net'))
      const hasServeoContent = result.some(
        (o) => o instanceof RegExp && o.test('tunnel.serveousercontent.com'),
      )
      expect(hasServeoNet).toBe(true)
      expect(hasServeoContent).toBe(true)
    })

    it('empty string CORS_ORIGINS behaves as not provided (fallback)', () => {
      const result = parseCorsOrigins({
        corsOrigins: '',
        frontendUrl: FRONTEND_URL,
        isProduction: true,
      })

      expect(result).toEqual([FRONTEND_URL])
    })
  })

  describe('whitespace and empty segment filtering', () => {
    it('trims whitespace around origin values', () => {
      const result = parseCorsOrigins({
        corsOrigins: '  https://app.cheekycheese.tech , https://cheekycheese.tech  ',
        frontendUrl: FRONTEND_URL,
        isProduction: true,
      })

      expect(result).toEqual(['https://app.cheekycheese.tech', 'https://cheekycheese.tech'])
    })

    it('filters out empty segments (double commas, trailing comma)', () => {
      const result = parseCorsOrigins({
        corsOrigins: 'https://app.cheekycheese.tech,,https://cheekycheese.tech,',
        frontendUrl: FRONTEND_URL,
        isProduction: true,
      })

      expect(result).toEqual(['https://app.cheekycheese.tech', 'https://cheekycheese.tech'])
    })

    it('CORS_ORIGINS with only whitespace/commas behaves as not provided', () => {
      const result = parseCorsOrigins({
        corsOrigins: '  ,  ,  ',
        frontendUrl: FRONTEND_URL,
        isProduction: true,
      })

      expect(result).toEqual([FRONTEND_URL])
    })
  })

  describe('production security: no dev-tunnel regexes in prod', () => {
    it('never returns RegExp instances in production regardless of input', () => {
      const result = parseCorsOrigins({
        corsOrigins: undefined,
        frontendUrl: FRONTEND_URL,
        isProduction: true,
      })

      const hasRegExp = result.some((o) => o instanceof RegExp)
      expect(hasRegExp).toBe(false)
    })
  })
})
