import { existsSync } from 'node:fs'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { anonymizeOld, createDb, migrate } from './db.js'

// Local development reads .env; on Railway the variables come from the service settings.
if (existsSync('.env')) process.loadEnvFile('.env')

const config = loadConfig()
const db = createDb(config.databaseUrl, config.databaseSsl)
await migrate(db)
const app = await buildApp(config, db)

/** Retention: emails older than RETENTION_DAYS are removed at boot and every 6 hours after. */
async function sweep() {
  try {
    const cleared = await anonymizeOld(db, config.retentionDays)
    if (cleared) app.log.info({ cleared, days: config.retentionDays }, 'retention: removed old emails')
  } catch (error) {
    app.log.error({ err: (error as Error).message }, 'retention sweep failed')
  }
}
await sweep()
setInterval(sweep, 6 * 3_600_000).unref()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    Promise.all([app.close(), db.end()]).then(
      () => process.exit(0),
      () => process.exit(1),
    )
  })
}

await app.listen({ host: '0.0.0.0', port: config.port })
