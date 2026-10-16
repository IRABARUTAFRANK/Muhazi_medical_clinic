/**
 * Concatenates supabase/migrations/*.sql and seed.sql into supabase/all.sql,
 * ready to paste once into the Supabase SQL editor.   pnpm db:bundle
 */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'supabase', 'migrations')
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
let out = `-- Muhazi Medical Clinic System — all migrations + seed, generated ${new Date().toISOString()}\n-- Paste into the Supabase SQL editor and run once on an empty project.\n\n`
for (const f of files)
  out += `-- ============================================================ ${f}\n${await readFile(path.join(dir, f), 'utf8')}\n\n`
out += `-- ============================================================ seed.sql\n${await readFile(path.join(root, 'supabase', 'seed.sql'), 'utf8')}\n`
await writeFile(path.join(root, 'supabase', 'all.sql'), out)
console.log(`supabase/all.sql written (${files.length} migrations + seed, ${out.length} chars)`)
