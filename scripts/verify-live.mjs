/**
 * Smoke test against the real Supabase project with the publishable key only:
 * public reads, manager sign-in, record_sign_in, staff directory, anonymous denial.
 *
 *   pnpm db:verify            (reads .env and apps/web/.env.local)
 *   MANAGER_PIN=<t.mugabo PIN> pnpm db:verify   # the manager PIN printed by seed-staff (or put it in .env)
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
for (const file of ['.env', 'apps/web/.env.local']) {
  try {
    const env = await readFile(path.join(root, file), 'utf8')
    for (const line of env.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
    }
  } catch {
    /* optional */
  }
}

const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const domain = process.env.VITE_STAFF_EMAIL_DOMAIN ?? 'staff.muhaziclinic.rw'
const pin = process.env.MANAGER_PIN
if (!url || !key || !pin) {
  console.error(
    'Set VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY and MANAGER_PIN (root .env) first.',
  )
  process.exit(1)
}

const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${name.padEnd(52)} ${detail}`)
}

const { data: practitioners, error: pe } = await sb.from('public_practitioners').select('code')
check(
  'anon reads public_practitioners',
  !pe && (practitioners?.length ?? 0) > 0,
  pe?.message ?? `${practitioners?.length} rows`,
)

const { data: lines, error: le } = await sb
  .from('public_service_lines')
  .select('category, price_from')
check(
  'anon reads public_service_lines',
  !le && (lines?.length ?? 0) > 0,
  le?.message ?? `${lines?.length} categories`,
)

// Empty is expected until the clinic signs its first insurer (payers are seeded inactive).
const { data: payers, error: ye } = await sb.from('public_payers').select('name')
check(
  'anon reads public_payers',
  !ye && Array.isArray(payers),
  ye?.message ?? `${payers?.length} active insurers`,
)

const { data: status, error: se } = await sb.rpc('public_clinic_status')
check(
  'anon calls public_clinic_status()',
  !se && typeof status?.open === 'boolean',
  se?.message ?? JSON.stringify(status),
)

const { data: info, error: ie } = await sb.rpc('public_clinic_info')
check(
  'anon calls public_clinic_info()',
  !ie && info?.profile?.phone,
  ie?.message ?? `phone ${info?.profile?.phone}`,
)

const { error: prof } = await sb.from('profiles').select('id')
check('anon is denied profiles', Boolean(prof), prof ? `denied (${prof.code})` : 'ALLOWED — wrong')

const { error: appt } = await sb.from('appointment').select('id')
check(
  'anon is denied appointments',
  Boolean(appt),
  appt ? `denied (${appt.code})` : 'ALLOWED — wrong',
)

const { data: signIn, error: sie } = await sb.auth.signInWithPassword({
  email: `t.mugabo@${domain}`,
  password: pin,
})
check(
  'manager signs in with username + PIN',
  !sie && Boolean(signIn?.user),
  sie?.message ?? 't.mugabo',
)

if (!sie) {
  const { data: me, error: re } = await sb.rpc('record_sign_in', { p_device: 'verify-live' })
  check(
    'record_sign_in() returns the profile',
    !re && me?.role === 'manager',
    re?.message ?? `role=${me?.role} must_change_pin=${me?.must_change_pin}`,
  )

  const { data: dir, error: de } = await sb.from('staff_directory').select('username, role, active')
  check(
    'manager reads staff_directory',
    !de && (dir?.length ?? 0) > 0,
    de?.message ?? `${dir?.length} employees`,
  )

  const { data: hiv, error: he } = await sb.from('hiv_test').select('id')
  check(
    'manager cannot read hiv_test (sensitive)',
    !he && (hiv?.length ?? 0) === 0,
    he?.message ?? `${hiv?.length} rows visible`,
  )

  const { data: svc, error: ce } = await sb.from('service').select('code').limit(3)
  check(
    'manager reads the catalogue',
    !ce && (svc?.length ?? 0) > 0,
    ce?.message ?? `${svc?.length} services`,
  )

  await sb.auth.signOut()
}

console.log(`\n${failures === 0 ? 'all live checks passed' : failures + ' check(s) failed'}`)
process.exit(failures ? 1 : 0)
