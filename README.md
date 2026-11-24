# switchboard-api

The API behind the internal **Switchboard** (`../switchboard-web`). Brand websites send each form submission
here server to server, and staff read them in the dashboard. It keeps only the **email, when, an opaque site code,
consult or callback, and where the visitor came from** (Google Ads, Meta Ads, organic search…). Nothing stored names a
brand or a treatment: no page routes, keywords or ad names, and sites are codes (`s1`…) whose names live only in
`SITE_LABELS`. Names, phones, clinic choice, IPs and free text are ignored even if a site sends them; sites still
deliver those by their own email.

Hiding the context lowers the harm of a leak but does not make an email + "asked a clinic for care" non-PHI under
HIPAA. If the practice is a covered entity, host this under a BAA: Railway signs one only on Enterprise (about
$1,000/month committed), while AWS signs one at no extra cost. The shared dashboard password is also not HIPAA-grade
access control (that needs individual logins and an access log). Fastify 5 + Postgres, one table, deployed on Railway.

Quick and dirty on purpose: the schema is created on boot (`src/db.ts`, no migration tool), one shared dashboard
password, no user accounts.

## Endpoints

| Method | Path | Who | Notes |
|---|---|---|---|
| `GET` | `/health` | Railway | Checks the database. |
| `POST` | `/v1/submissions` | Brand sites, server side | `Authorization: Bearer <site key>`. The key decides the site. 120/min/IP. |
| `POST` | `/v1/auth/login` | Dashboard | `{ password }` → `{ token, expiresAt }`. 10/min/IP. |
| `GET` | `/v1/summary` | Dashboard | Each site with total and new counts, and each traffic source with its count. |
| `GET` | `/v1/submissions?site=&channel=&status=&q=&offset=` | Dashboard | 50 per page, newest first. `q`: a full email address (exact, any case) or part of a campaign / UTM source. |
| `PATCH` | `/v1/submissions/:id` | Dashboard | `{ status: "new" \| "contacted" \| "archived" }`. |

Dashboard routes need `Authorization: Bearer <session token>` and only answer browsers on `DASHBOARD_ORIGINS`.

### Sending a submission (from a site's server code, never the browser)

```bash
curl -X POST "$SWITCHBOARD_API_URL/v1/submissions" \
  -H "Authorization: Bearer $SWITCHBOARD_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "externalId": "the site'\''s own submission id (makes retries safe)",
    "form": "contact",
    "submittedAt": "2026-11-24T18:00:00.000Z",
    "email": "…",
    "attribution": {
      "utmSource": "google", "utmMedium": "cpc", "utmCampaign": "21839940122",
      "clickIds": ["gclid"],
      "referrerHost": "www.google.com",
      "landedAt": "2026-11-24T17:55:00.000Z"
    }
  }'
```

`email` is required; everything else is optional, and over-long values are clipped, never rejected, so a lead is not
lost to validation here. The same `externalId` twice from one site is stored once.

`attribution` is what the site saw on the landing page. `clickIds` names which ad click IDs were present, never their
values. `referrerHost` is used to work out the label and then dropped. Anything else (landing page, `utm_term`,
`utm_content`, page routes) is ignored, because it can name a treatment. Dr. Vigor's browser half is
`src/lib/attribution.ts` there (30 days in localStorage, last non-direct visit wins); copy it for the other sites.

### Traffic source labels (`src/attribution.ts`)

| Label | When |
|---|---|
| Google Ads | `gclid` / `gbraid` / `wbraid` present (Google auto-tagging, no UTMs needed), or a paid medium from google |
| Meta Ads | a paid medium (`cpc`, `paid`, `paid_social`…) with source facebook / fb / instagram / ig / meta |
| Microsoft Ads, TikTok Ads | `msclkid` / `ttclid`, or a paid medium from that network |
| Other paid | any other paid medium |
| Facebook / Instagram | `fbclid` or a Facebook/Instagram referrer without a paid UTM. Meta adds `fbclid` to ad clicks and to ordinary post links alike, so this can be either |
| Email, Organic search, Social, Other campaign, Referral, Direct | in that order, from the medium, the referrer host, or nothing at all |

**To see Meta ads as "Meta Ads"**, add URL parameters in Ads Manager (ad → Tracking → URL parameters):
`utm_source=facebook&utm_medium=paid_social&utm_campaign={{campaign.id}}`. Google Ads needs nothing as long as
auto-tagging is on (the default); to see campaigns, add `utm_source=google&utm_medium=cpc&utm_campaign={campaignid}`
as a tracking template suffix. Use campaign **IDs**, not names: a name like "ed-shockwave" would name a treatment
next to an email, an ID can be looked up in the ad account.

## Run it locally

```bash
createdb switchboard_dev            # local Postgres
cp .env.example .env                # fill in; `npm run key` makes each key/secret
npm install
npm run dev                         # http://localhost:4300
```

The dashboard runs on `http://localhost:5174` (`npm run dev` in `../switchboard-web`).

## Protections while this runs on Railway (until the move to AWS)

In the code:

- **Emails encrypted at rest** (AES-256-GCM, `src/crypto.ts`, key `DATA_KEY`). A database dump, a Railway backup or
  anyone with database access sees ciphertext. Exact-address search uses an HMAC blind index; partial email search is
  not possible by design.
- **Emails removed after `RETENTION_DAYS`** (90): at boot and every 6 hours, older rows lose their email and keep the
  date, site code and source for ad reporting.
- **Nothing stored names a brand or a treatment**: site codes, no routes, keywords or ad names.
- **Access log** (`access_log` table): sign-ins, failed sign-ins and status changes, with time and IP.
- 8-hour sessions, rate-limited sign-in, CORS limited to the dashboard, `Cache-Control: no-store` on every response,
  no request bodies or query strings in the logs.

In Railway (manual, once):

- Postgres service → **Settings → Networking**: remove the **TCP Proxy** (public networking) so the database is only
  reachable on Railway's private network. The API uses `${{Postgres.DATABASE_URL}}`, which is private.
- Limit the project's members to people who need it, and require 2FA on their Railway accounts.
- Store `DATA_KEY` in the team password manager. Without it, stored emails cannot be read.

Still open (needs AWS or more work): a BAA with the host, individual dashboard logins instead of one shared password,
and key rotation for `DATA_KEY`.

## Deploy to Railway

1. Railway → **New Project** → **Deploy from GitHub repo** → `COOL-MARKETING/switchboard-api`. `railway.json`
   sets the build (`npm run build`), start (`npm start`) and the `/health` check.
2. In the same project: **+ New** → **Database** → **PostgreSQL**. Then remove its TCP Proxy (see above).
3. On the API service → **Variables → Raw Editor**: paste the generated `.env.railway` (kept outside git). It holds:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `SITE_KEYS` = `s1=<key>,s2=<key>,…` and `SITE_LABELS` = `s1=Dr. Vigor,…` (labels shown only to signed-in staff;
     check it shows without the surrounding quotes after pasting)
   - `DASHBOARD_PASSWORD`, `SESSION_SECRET`, `DATA_KEY`, `SESSION_HOURS`, `RETENTION_DAYS`
   - `DASHBOARD_ORIGINS` = the dashboard's Vercel URL (fix it after the dashboard's first deploy)
4. API service → **Settings → Networking → Generate Domain**. That URL is `VITE_API_URL` for the dashboard and
   `SWITCHBOARD_API_URL` for each site.
5. `curl https://<domain>/health` → `{"ok":true}`.

## Adding a site

`npm run key`, pick the next code (`s5`…), append `s5=<key>` to `SITE_KEYS` and `s5=<Name>` to `SITE_LABELS` on
Railway, give the site `SWITCHBOARD_API_URL` and `SWITCHBOARD_API_KEY`, capture attribution in the browser (copy Dr.
Vigor's `src/lib/attribution.ts`), and POST from its form handler. Never use a brand name as the code. Current
codes: s1 Dr. Vigor, s2 Dr. Neo, s3 Dr. Sculpt, s4 Dr. Food.
