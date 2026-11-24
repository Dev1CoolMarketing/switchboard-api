import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Config } from './config.js'

/** Constant-time comparison of two secrets of any length. */
export function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(a), digest(b))
}

/**
 * First 8 hex characters of a value's SHA-256: safe to log, enough to tell whether a site sent the key
 * you expect. Compare with: printf %s "$KEY" | shasum -a 256 | cut -c1-8
 */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

export function bearer(header: string | undefined): string {
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

/** Which site an ingest key belongs to, or null. Every key is checked so timing says nothing. */
export function siteForKey(config: Config, key: string): string | null {
  let match: string | null = null
  for (const entry of config.siteKeys) {
    if (safeEqual(entry.key, key) && key) match = entry.site
  }
  return match
}

/**
 * Dashboard sessions: `<expiry ms>.<hmac>`, signed with SESSION_SECRET. Stateless, so rotating
 * SESSION_SECRET signs everyone out. The dashboard sends it as a Bearer header; a cookie would be
 * third-party between *.vercel.app and *.up.railway.app and browsers block those.
 */
export function issueSession(config: Config): { token: string; expiresAt: string } {
  const expiresAt = Date.now() + config.sessionHours * 3_600_000
  return { token: `${expiresAt}.${sign(config, String(expiresAt))}`, expiresAt: new Date(expiresAt).toISOString() }
}

export function validSession(config: Config, token: string): boolean {
  const [expiry, signature] = token.split('.')
  if (!expiry || !signature || !/^\d+$/.test(expiry)) return false
  return safeEqual(signature, sign(config, expiry)) && Number(expiry) > Date.now()
}

function sign(config: Config, value: string): string {
  return createHmac('sha256', config.sessionSecret).update(`session:${value}`).digest('base64url')
}
