/**
 * Everything the API reads from the environment, checked once at boot so a missing secret
 * stops the deploy instead of surfacing as a 500 on the first request.
 */
export type Config = {
  port: number
  databaseUrl: string
  databaseSsl: boolean
  /** One ingest key per site code. The key decides which site a submission is filed under. */
  siteKeys: { site: string; key: string }[]
  /**
   * Display names for the site codes (s1 → "Dr. Vigor"). Shown only to signed-in dashboard users,
   * never stored with a submission. Empty: the dashboard shows the codes.
   */
  siteLabels: Map<string, string>
  dashboardPassword: string
  sessionSecret: string
  sessionHours: number
  /** Exact browser origins allowed to call the dashboard routes. */
  dashboardOrigins: string[]
  /** 64 hex chars. Encrypts emails at rest (src/crypto.ts). */
  dataKey: string
  /** Emails are removed from rows older than this; the date and source stay for reporting. */
  retentionDays: number
}

const SITE_SLUG = /^[a-z0-9-]{1,40}$/

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string): string => {
    const value = env[name]?.trim()
    if (!value) throw new Error(`${name} is not set`)
    return value
  }

  const dashboardPassword = required('DASHBOARD_PASSWORD')
  if (dashboardPassword.length < 12) throw new Error('DASHBOARD_PASSWORD must be at least 12 characters')
  const sessionSecret = required('SESSION_SECRET')
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters')

  return {
    port: Number(env.PORT ?? 4300),
    databaseUrl: required('DATABASE_URL'),
    databaseSsl: env.DATABASE_SSL === 'true',
    siteKeys: parseSiteKeys(required('SITE_KEYS')),
    siteLabels: parseSiteLabels(env.SITE_LABELS ?? ''),
    dashboardPassword,
    sessionSecret,
    sessionHours: Number(env.SESSION_HOURS ?? 8),
    dataKey: required('DATA_KEY'),
    retentionDays: Math.max(1, Number(env.RETENTION_DAYS ?? 90)),
    dashboardOrigins: required('DASHBOARD_ORIGINS')
      .split(',')
      .map((origin) => origin.trim().replace(/\/$/, ''))
      .filter(Boolean),
  }
}

/** `s1=Dr. Vigor,s2=Dr. Neo` → Map. Labels may contain spaces and dots, not commas. */
function parseSiteLabels(raw: string): Config['siteLabels'] {
  const labels = new Map<string, string>()
  for (const pair of raw.split(',')) {
    const at = pair.indexOf('=')
    const site = pair.slice(0, at).trim()
    const label = pair.slice(at + 1).trim()
    if (at > 0 && SITE_SLUG.test(site) && label) labels.set(site, label.slice(0, 60))
  }
  return labels
}

/** `s1=<key>,s2=<key>` → [{ site, key }]. Keys must be long random strings (`npm run key`). */
function parseSiteKeys(raw: string): Config['siteKeys'] {
  const entries = raw.split(',').map((pair) => pair.trim()).filter(Boolean)
  return entries.map((pair) => {
    const at = pair.indexOf('=')
    const site = pair.slice(0, at).trim()
    const key = pair.slice(at + 1).trim()
    if (at <= 0 || !SITE_SLUG.test(site)) throw new Error(`SITE_KEYS: "${site || pair.slice(0, 10)}" is not a valid site slug`)
    if (key.length < 32) throw new Error(`SITE_KEYS: the key for ${site} must be at least 32 characters`)
    return { site, key }
  })
}
