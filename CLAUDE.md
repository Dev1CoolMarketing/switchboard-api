# switchboard-api

Internal API for the Switchboard. Brand sites (Dr. Vigor, Dr. Neo, Dr. Sculpt, Dr. Food) POST form submissions here
server to server; `../switchboard-web` reads them. Fastify 5 + `pg`, one `submissions` table, Railway.
See README.md for endpoints and deploy.

- Internal use only. Dashboard routes sit behind the shared-password session (`src/auth.ts`) and CORS limited to
  `DASHBOARD_ORIGINS`. Never add an unauthenticated read route.
- The ingest key decides the site. Never trust a `site` field from the body.
- Never log request bodies or query strings (they hold emails and searches). The logger serializer strips queries.
- Stores only email, date, opaque site code, form type and traffic source (`channel` + `attribution`). Nothing
  stored may name a brand or a treatment: no page routes, landing pages, utm_term/utm_content, referrer hosts, and
  site codes (s1…) instead of brand slugs. Brand names live only in `SITE_LABELS`. No name, phone, clinic, IP or
  free-text columns (user decisions 2026-11-24).
- Click IDs: store which kinds were present, never their values. Channel rules live in `src/attribution.ts` only.
- Emails are encrypted at rest (`src/crypto.ts`, `DATA_KEY`) with an HMAC blind index for exact search. Never add a
  plaintext email column or log an address. Emails are removed after `RETENTION_DAYS`; keep that sweep in place.
- Dashboard sign-ins and status changes go to `access_log`. Log any new dashboard write there too.
- Schema lives in `src/db.ts` and runs on every boot. Change it only with `if not exists` statements.
- Checks: `npm run typecheck`, `npm run build`. Smoke test against a local `switchboard_dev` database.
