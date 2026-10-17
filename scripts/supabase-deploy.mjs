/**
 * Deploys the Edge Functions with the Supabase CLI (downloaded by npx; no Docker needed):
 *   manage-staff     manager actions (needs the caller's session → JWT verified by the gateway)
 *   staff-otp        PIN-gated sign-in code request (public endpoint, --no-verify-jwt)
 *   send-auth-email  Auth "Send Email" hook (called by Supabase Auth, --no-verify-jwt)
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_… node scripts/supabase-deploy.mjs [function …]
 *   (the token can live in the root .env)
 */
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
try {
  const env = await readFile(path.join(root, '.env'), 'utf8')
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {
  /* no .env */
}

const token = process.env.SUPABASE_ACCESS_TOKEN
const url = process.env.SUPABASE_URL || ''
const ref = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1]
if (!token || !ref) {
  console.error('Set SUPABASE_ACCESS_TOKEN and SUPABASE_URL in .env first.')
  process.exit(1)
}

const FUNCTIONS = {
  'manage-staff': [],
  'staff-otp': ['--no-verify-jwt'],
  'send-auth-email': ['--no-verify-jwt'],
}
const wanted = process.argv.slice(2).filter((a) => a in FUNCTIONS)
const names = wanted.length ? wanted : Object.keys(FUNCTIONS)

let failed = 0
for (const name of names) {
  console.log(`\n→ deploying ${name}`)
  const r = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    [
      '--yes',
      'supabase@latest',
      'functions',
      'deploy',
      name,
      '--project-ref',
      ref,
      '--use-api',
      ...FUNCTIONS[name],
    ],
    {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, SUPABASE_ACCESS_TOKEN: token },
    },
  )
  if (r.status !== 0) failed += 1
}
console.log(failed ? `\n${failed} deployment(s) failed` : '\nall functions deployed')
process.exit(failed ? 1 : 0)
