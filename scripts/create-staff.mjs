/**
 * Creates one staff account from the command line with the secret key (same effect as the
 * manager's "New employee" form). Useful for the first managers, before anyone can sign in.
 *
 *   node scripts/create-staff.mjs <username> "<Full name>" <role> <email> [station] [--head]
 *   e.g. node scripts/create-staff.mjs n.tech "Novostella Technologies" manager novostella@example.com
 *
 * Roles: receptionist, cashier, nurse, doctor, sonographer, lab_tech, pharmacist, manager.
 * Prints the staff ID, username and the random first PIN once (the employee must change it).
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
  /* no .env */
}

const ROLES = [
  'receptionist',
  'cashier',
  'nurse',
  'doctor',
  'sonographer',
  'lab_tech',
  'pharmacist',
  'manager',
]
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const head = process.argv.includes('--head')
const [username, fullName, role, email, station] = args
const url = process.env.SUPABASE_URL
const secret = process.env.SUPABASE_SECRET_KEY
if (
  !url ||
  !secret ||
  !/^[a-z0-9._-]{3,32}$/.test(username ?? '') ||
  !fullName ||
  !ROLES.includes(role ?? '') ||
  !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email ?? '')
) {
  console.error(
    'Usage: node scripts/create-staff.mjs <username> "<Full name>" <role> <email> [station] [--head]',
  )
  process.exit(1)
}

const admin = createClient(url, secret, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const { data: taken } = await admin
  .from('profiles')
  .select('id')
  .eq('username', username)
  .maybeSingle()
if (taken) {
  console.error(`username ${username} already exists`)
  process.exit(1)
}
const pin = String(randomInt(0, 1_000_000)).padStart(6, '0')
const { data, error } = await admin.auth.admin.createUser({
  email: email.toLowerCase(),
  password: pin,
  email_confirm: true,
  user_metadata: {
    username,
    full_name: fullName,
    role,
    station: station || null,
    dashboard: role === 'manager' ? 'manager' : head ? 'head' : null,
    head_of: head ? station || null : null,
    language: 'kin',
    must_change_pin: true,
  },
})
if (error) {
  console.error(error.message)
  process.exit(1)
}
const { data: profile } = await admin
  .from('profiles')
  .select('staff_id')
  .eq('id', data.user.id)
  .maybeSingle()
console.log(`created ${fullName} (${role})`)
console.log(`  staff ID : ${profile?.staff_id ?? '?'}`)
console.log(`  username : ${username}`)
console.log(`  e-mail   : ${email.toLowerCase()}`)
console.log(`  first PIN: ${pin}   (shown once; must be changed at first sign-in)`)
