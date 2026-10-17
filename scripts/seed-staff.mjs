/**
 * Creates the sample staff accounts in Supabase Auth. The `handle_new_user` trigger turns the
 * metadata into a `profiles` row (role, station, dashboard).
 *
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY=sb_secret_... node scripts/seed-staff.mjs
 *   (or put both in the root .env — this script reads it)
 *
 * PINs: a random six-digit PIN is generated for each account and printed once.
 * Hand it over in person; the app forces a PIN change at first sign-in.
 */
import { randomInt } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
try {
  const env = await readFile(path.join(root, '.env'), 'utf8')
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {
  /* no .env file: rely on the environment */
}

const url = process.env.SUPABASE_URL
const secret = process.env.SUPABASE_SECRET_KEY
const domain = process.env.STAFF_EMAIL_DOMAIN ?? 'staff.muhaziclinic.rw'
if (!url || !secret) {
  console.error('Set SUPABASE_URL and SUPABASE_SECRET_KEY (root .env) first.')
  process.exit(1)
}

const randomPin = () => String(randomInt(0, 1_000_000)).padStart(6, '0')

const STAFF = [
  { username: 'j.uwimana', full_name: 'Uwimana Josiane', role: 'receptionist' },
  {
    username: 'c.nyirahabimana',
    full_name: 'Nyirahabimana Chantal',
    role: 'nurse',
    station: 'Triage',
  },
  {
    username: 'b.mukamana',
    full_name: 'Dr. Mukamana Béatrice',
    role: 'doctor',
    station: 'Consultation 1',
  },
  { username: 's.mugisha', full_name: 'Mugisha Samuel', role: 'cashier' },
  {
    username: 'p.kalisa',
    full_name: 'Kalisa Pascal',
    role: 'pharmacist',
    station: 'Pharmacy',
  },
  {
    username: 'a.ingabire',
    full_name: 'Ingabire Aline',
    role: 'lab_tech',
    station: 'Laboratory',
  },
  {
    username: 't.mugabo',
    full_name: 'Mugabo Théogène',
    role: 'manager',
    dashboard: 'manager',
  },
  {
    username: 'f.ndayisaba',
    full_name: 'Dr. Ndayisaba Félix',
    role: 'doctor',
    station: 'Dental',
    dashboard: 'head',
    head_of: 'Dental',
  },
]

const admin = createClient(url, secret, {
  auth: { autoRefreshToken: false, persistSession: false },
})

for (const s of STAFF) {
  const pin = randomPin()
  const email = `${s.username}@${domain}`
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: pin,
    email_confirm: true,
    user_metadata: { ...s, language: 'kin' },
  })
  if (error) {
    console.log(`skip ${email}: ${error.message}`)
    continue
  }
  const { data: profile } = await admin
    .from('profiles')
    .select('staff_id')
    .eq('id', data.user?.id)
    .maybeSingle()
  console.log(
    `created ${email} (${data.user?.id}) role=${s.role}  staffId=${profile?.staff_id ?? '?'}  username=${s.username}  PIN=${pin}`,
  )
}
console.log(
  'Done. Sign in on the landing page with the username and the PIN printed above (shown once).',
)
