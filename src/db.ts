import pg from 'pg'

export type Db = pg.Pool

export function createDb(url: string, ssl: boolean): Db {
  // Railway's private network (postgres.railway.internal) needs no TLS; its public proxy does.
  return new pg.Pool({ connectionString: url, max: 5, ssl: ssl ? { rejectUnauthorized: false } : undefined })
}

/**
 * The whole schema. Quick-and-dirty on purpose: it runs on every boot and only creates what is
 * missing, so there is no migration tool. Add columns with `add column if not exists`.
 *
 * Deliberately small, and nothing in it names a brand or a treatment: the email (encrypted, see
 * src/crypto.ts), when, an opaque site code (`s1`…; names live only in SITE_LABELS), the form type,
 * and the traffic source. No name, phone, clinic, IP, page route or free text.
 *
 * After RETENTION_DAYS the email is removed (`anonymized_at`), leaving the date and source for ad
 * reporting.
 */
const SCHEMA = `
create table if not exists submissions (
  id            uuid primary key default gen_random_uuid(),
  site          text not null,
  form          text not null default 'contact',
  external_id   text,
  email_enc     text,
  email_index   text,
  channel       text not null default 'Direct',
  attribution   jsonb not null default '{}'::jsonb,
  status        text not null default 'new' check (status in ('new', 'contacted', 'archived')),
  submitted_at  timestamptz not null default now(),
  received_at   timestamptz not null default now(),
  status_changed_at timestamptz,
  anonymized_at timestamptz,
  unique (site, external_id)
);
create index if not exists submissions_received_idx on submissions (received_at desc);
create index if not exists submissions_site_received_idx on submissions (site, received_at desc);
create index if not exists submissions_channel_idx on submissions (channel);
create index if not exists submissions_email_index_idx on submissions (email_index);

-- Who did what in the dashboard. The password is shared, so the IP is the only "who" for now.
create table if not exists access_log (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  event   text not null,
  ip      text,
  detail  jsonb not null default '{}'::jsonb
);
create index if not exists access_log_at_idx on access_log (at desc);
`

export async function migrate(db: Db): Promise<void> {
  await db.query(SCHEMA)
}

/** Removes emails older than the retention window. Returns how many rows it cleared. */
export async function anonymizeOld(db: Db, days: number): Promise<number> {
  const result = await db.query(
    `update submissions set email_enc = null, email_index = null, anonymized_at = now()
      where anonymized_at is null and received_at < now() - make_interval(days => $1)`,
    [days],
  )
  return result.rowCount ?? 0
}

export async function logAccess(db: Db, event: string, ip: string, detail: Record<string, unknown> = {}): Promise<void> {
  await db.query('insert into access_log (event, ip, detail) values ($1, $2, $3)', [event, ip, JSON.stringify(detail)])
}
