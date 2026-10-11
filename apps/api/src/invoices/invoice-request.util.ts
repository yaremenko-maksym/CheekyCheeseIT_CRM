import type { FastifyRequest } from 'fastify'

/**
 * Extract the client IP from a Fastify request. We prefer `req.ip` (which
 * Fastify resolves through trustProxy if configured) and fall back to
 * `x-forwarded-for`. Returns null when neither is available so the DB
 * column stays NULL instead of an empty string.
 */
export function extractIp(req: FastifyRequest): string | null {
  if (req.ip) return req.ip
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0]!.trim()
  }
  if (Array.isArray(xff) && xff.length > 0) {
    return xff[0]!.split(',')[0]!.trim()
  }
  return null
}

export function extractUserAgent(req: FastifyRequest): string | null {
  const ua = req.headers['user-agent']
  if (typeof ua === 'string' && ua.length > 0) return ua
  return null
}

/** Last octet of an IPv4 string; empty for IPv6 / null inputs. */
export function lastOctet(ip: string): string | null {
  const m = /^(\d+\.\d+\.\d+\.)(\d+)$/.exec(ip)
  return m ? m[2]! : null
}
