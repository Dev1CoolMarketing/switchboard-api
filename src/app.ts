import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyInstance } from 'fastify'
import { deriveChannel, readAttribution, toStored, type Attribution } from './attribution.js'
import { bearer, fingerprint, issueSession, safeEqual, siteForKey, validSession } from './auth.js'
import type { Config } from './config.js'
import { dataKeys, decrypt, emailIndex, encrypt, type DataKeys } from './crypto.js'
import { logAccess, type Db } from './db.js'

const STATUSES = ['new', 'contacted', 'archived'] as const
type Status = (typeof STATUSES)[number]
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function buildApp(config: Config, db: Db): Promise<FastifyInstance> {
  const keys = dataKeys(config.dataKey)
  const app = Fastify({
    trustProxy: true, // Railway terminates TLS in front of us
    bodyLimit: 64 * 1024,
    logger: {
      // No query strings in the logs: dashboard searches can be email addresses.
      serializers: { req: (req) => ({ method: req.method, url: req.url.split('?')[0], ip: req.ip }) },
    },
  })

  await app.register(cors, {
    origin: config.dashboardOrigins,
    methods: ['GET', 'POST', 'PATCH'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  })
  await app.register(rateLimit, { global: false })

  // Lead data must never sit in a browser or proxy cache.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store')
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
  })

  app.get('/health', async () => {
    await db.query('select 1')
    return { ok: true }
  })

  /* ── Ingest: called server-to-server by each site's form handler ───────────────────────── */

  app.post('/v1/submissions', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const key = bearer(req.headers.authorization)
    const site = siteForKey(config, key)
    if (!site) {
      // Fingerprint, never the key: lets a mismatched SWITCHBOARD_API_KEY be compared with the expected one.
      req.log.warn(
        { keyFingerprint: key ? fingerprint(key) : null, keyLength: key.length, hasBearer: Boolean(req.headers.authorization?.startsWith('Bearer ')) },
        'ingest rejected: unknown site key',
      )
      return reply.code(401).send({ ok: false, error: 'Unknown site key.' })
    }

    const submission = readSubmission(req.body)
    if (!submission) return reply.code(400).send({ ok: false, error: 'Expected a JSON object with an email address.' })

    const inserted = await db.query<{ id: string }>(
      `insert into submissions
         (site, form, external_id, email_enc, email_index, channel, attribution, submitted_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (site, external_id) do nothing
       returning id`,
      [
        site,
        submission.form,
        submission.externalId,
        encrypt(keys, submission.email),
        emailIndex(keys, submission.email),
        // The label is worked out from everything the site sent; only the safe part is kept.
        deriveChannel(submission.attribution),
        JSON.stringify(toStored(submission.attribution)),
        submission.submittedAt,
      ],
    )
    if (inserted.rows[0]) return reply.code(201).send({ ok: true, id: inserted.rows[0].id })

    // Same site + externalId again: a retry. Answer as if stored so the caller stops retrying.
    const existing = await db.query<{ id: string }>(
      'select id from submissions where site = $1 and external_id = $2',
      [site, submission.externalId],
    )
    return reply.code(200).send({ ok: true, id: existing.rows[0]?.id, duplicate: true })
  })

  /* ── Dashboard ─────────────────────────────────────────────────────────────────────────── */

  app.post('/v1/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const password = (req.body as { password?: unknown } | undefined)?.password
    if (typeof password !== 'string' || !safeEqual(password, config.dashboardPassword)) {
      await logAccess(db, 'login_failed', req.ip)
      return reply.code(401).send({ ok: false, error: 'Wrong password.' })
    }
    await logAccess(db, 'login', req.ip)
    return { ok: true, ...issueSession(config) }
  })

  await app.register(async (dashboard) => {
    dashboard.addHook('onRequest', async (req, reply) => {
      if (!validSession(config, bearer(req.headers.authorization))) {
        return reply.code(401).send({ ok: false, error: 'Signed out.' })
      }
    })

    /**
     * Counts for the filters: every site with a key plus any site that has rows, and every
     * traffic source that has rows (busiest first).
     */
    dashboard.get('/v1/summary', async () => {
      const [siteRows, channelRows] = await Promise.all([
        db.query<{ site: string; total: number; new_count: number; last_received_at: Date | null }>(
          `select site, count(*)::int as total, (count(*) filter (where status = 'new'))::int as new_count,
                  max(received_at) as last_received_at
             from submissions group by site`,
        ),
        db.query<{ channel: string; total: number }>(
          'select channel, count(*)::int as total from submissions group by channel order by total desc, channel',
        ),
      ])
      const bySite = new Map(siteRows.rows.map((row) => [row.site, row]))
      const slugs = [...new Set([...config.siteKeys.map((entry) => entry.site), ...bySite.keys()])].sort()
      return {
        sites: slugs.map((site) => ({
          site,
          label: config.siteLabels.get(site) ?? null,
          total: bySite.get(site)?.total ?? 0,
          newCount: bySite.get(site)?.new_count ?? 0,
          lastReceivedAt: bySite.get(site)?.last_received_at ?? null,
        })),
        channels: channelRows.rows,
      }
    })

    dashboard.get('/v1/submissions', async (req) => {
      const query = req.query as Record<string, string | undefined>
      const limit = clampInt(query.limit, 1, 100, 50)
      const offset = clampInt(query.offset, 0, 1_000_000, 0)

      const where: string[] = []
      const params: unknown[] = []
      const add = (sql: (n: number) => string, value: unknown) => {
        params.push(value)
        where.push(sql(params.length))
      }
      if (query.site) add((n) => `site = $${n}`, query.site)
      if (query.channel) add((n) => `channel = $${n}`, query.channel)
      if (query.status && isStatus(query.status)) add((n) => `status = $${n}`, query.status)
      const q = query.q?.trim().slice(0, 254)
      if (q?.includes('@')) {
        // Emails are encrypted, so an address is found by its exact blind index, not a partial match.
        add((n) => `email_index = $${n}`, emailIndex(keys, q))
      } else if (q) {
        const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`
        add((n) => `concat_ws(' ', attribution->>'utmCampaign', attribution->>'utmSource') ilike $${n}`, like)
      }
      const whereSql = where.length ? `where ${where.join(' and ')}` : ''

      const [list, count] = await Promise.all([
        db.query(
          `select * from submissions ${whereSql}
            order by received_at desc, id desc
            limit $${params.length + 1} offset $${params.length + 2}`,
          [...params, limit, offset],
        ),
        db.query<{ total: number }>(`select count(*)::int as total from submissions ${whereSql}`, params),
      ])
      return { total: count.rows[0]?.total ?? 0, limit, offset, submissions: list.rows.map((row) => toApi(keys, row)) }
    })

    dashboard.patch('/v1/submissions/:id', async (req, reply) => {
      const { id } = req.params as { id: string }
      const status = (req.body as { status?: unknown } | undefined)?.status
      if (!UUID.test(id)) return reply.code(404).send({ ok: false, error: 'Not found.' })
      if (typeof status !== 'string' || !isStatus(status)) {
        return reply.code(400).send({ ok: false, error: `status must be one of ${STATUSES.join(', ')}.` })
      }
      const { rows } = await db.query(
        'update submissions set status = $2, status_changed_at = now() where id = $1 returning *',
        [id, status],
      )
      if (!rows[0]) return reply.code(404).send({ ok: false, error: 'Not found.' })
      await logAccess(db, 'status_changed', req.ip, { id, status })
      return { ok: true, submission: toApi(keys, rows[0]) }
    })
  })

  return app
}

/* ── Helpers ───────────────────────────────────────────────────────────────────────────── */

type Submission = {
  externalId: string | null
  form: string
  submittedAt: Date
  email: string
  attribution: Attribution
}

/**
 * Reads only what the inbox keeps: the email, when, the form type, and where the visitor came from.
 * Name, phone, location, page routes or anything else in the body are ignored even if a site sends
 * them. Lenient otherwise: an over-long value is clipped, never rejected, so a lead is not lost.
 */
function readSubmission(body: unknown): Submission | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  const email = clip(b.email, 254)
  if (!email?.includes('@')) return null
  return {
    externalId: clip(b.externalId, 100),
    form: clip(b.form, 40)?.toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'contact',
    submittedAt: parseDate(b.submittedAt),
    email,
    attribution: readAttribution(b.attribution),
  }
}

function clip(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

/** The site's own timestamp if it is plausible, otherwise now. */
function parseDate(value: unknown): Date {
  const date = typeof value === 'string' ? new Date(value) : null
  const now = Date.now()
  return date && !Number.isNaN(date.getTime()) && Math.abs(now - date.getTime()) < 7 * 86_400_000 ? date : new Date(now)
}

function clampInt(value: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10)
  return Number.isNaN(n) ? fallback : Math.min(max, Math.max(min, n))
}

function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value)
}

function toApi(keys: DataKeys, row: Record<string, unknown>) {
  return {
    id: row.id,
    site: row.site,
    form: row.form,
    externalId: row.external_id,
    /** null once the retention window has removed it. */
    email: decrypt(keys, row.email_enc as string | null),
    anonymizedAt: row.anonymized_at,
    channel: row.channel,
    attribution: row.attribution,
    status: row.status,
    submittedAt: row.submitted_at,
    receivedAt: row.received_at,
    statusChangedAt: row.status_changed_at,
  }
}
