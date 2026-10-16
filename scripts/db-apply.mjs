/**
 * Applies supabase/migrations/*.sql (once each, tracked in mmc_migrations) and optionally the seed
 * to a real Postgres — the Supabase project or the clinic hub.
 *
 *   SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres \
 *     node scripts/db-apply.mjs [--seed] [--dry-run]
 *
 * The URL comes from Supabase → Project settings → Database → Connection string (session pooler,
 * IPv4). It can also live in the root .env. Nothing here needs Docker or the Supabase CLI.
 */
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
try {
  const env = await readFile(path.join(root, '.env'), 'utf8')
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {
  /* no .env: rely on the environment */
}

const url = process.env.SUPABASE_DB_URL
if (!url) {
  console.error('Set SUPABASE_DB_URL (root .env) to the Postgres connection string first.')
  process.exit(1)
}
const withSeed = process.argv.includes('--seed')
const dryRun = process.argv.includes('--dry-run')

const sql = postgres(url, { max: 1, ssl: 'require', prepare: false, onnotice: () => {} })
const dir = path.join(root, 'supabase', 'migrations')
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()

try {
  await sql.unsafe(`create table if not exists mmc_migrations (
    name text primary key, applied_at timestamptz not null default now())`)
  const done = new Set((await sql`select name from mmc_migrations`).map((r) => r.name))
  for (const f of files) {
    if (done.has(f)) {
      console.log(`skip   ${f}`)
      continue
    }
    const body = await readFile(path.join(dir, f), 'utf8')
    if (dryRun) {
      console.log(`would  ${f}`)
      continue
    }
    await sql.begin(async (tx) => {
      await tx.unsafe(body)
      await tx`insert into mmc_migrations (name) values (${f})`
    })
    console.log(`applied ${f}`)
  }
  if (withSeed && !dryRun) {
    const seeded = (await sql`select count(*)::int as n from payer`)[0].n
    if (seeded > 0) {
      console.log('skip   seed.sql (payers already present)')
    } else {
      await sql.unsafe(await readFile(path.join(root, 'supabase', 'seed.sql'), 'utf8'))
      console.log('applied seed.sql')
    }
  }
  const tables = (
    await sql`select count(*)::int as n from pg_tables where schemaname = 'public'`
  )[0].n
  console.log(`done · ${tables} tables in public`)
} finally {
  await sql.end()
}
