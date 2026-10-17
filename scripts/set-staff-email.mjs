/**
 * Sets the e-mail address of a staff account (where sign-in codes are sent) with the secret key.
 * Normally the manager does this from the Employees page; this is for the first manager account,
 * before the manage-staff function is reachable.
 *
 *   node scripts/set-staff-email.mjs <username> <email>
 *   (reads SUPABASE_URL and SUPABASE_SECRET_KEY from the root .env)
 */
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

const [username, email] = process.argv.slice(2)
const url = process.env.SUPABASE_URL
const secret = process.env.SUPABASE_SECRET_KEY
if (!url || !secret || !username || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
  console.error(
    'Usage: node scripts/set-staff-email.mjs <username> <email>  (SUPABASE_URL + SUPABASE_SECRET_KEY in .env)',
  )
  process.exit(1)
}

const admin = createClient(url, secret, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const { data: profile, error } = await admin
  .from('profiles')
  .select('id, staff_id, full_name, email')
  .eq('username', username.toLowerCase())
  .maybeSingle()
if (error || !profile) {
  console.error(error?.message ?? `no staff account with username ${username}`)
  process.exit(1)
}
const { error: updateError } = await admin.auth.admin.updateUserById(profile.id, {
  email: email.toLowerCase(),
  email_confirm: true,
})
if (updateError) {
  console.error(updateError.message)
  process.exit(1)
}
await admin.from('profiles').update({ email: email.toLowerCase() }).eq('id', profile.id)
console.log(
  `${profile.staff_id} ${profile.full_name} (${username}): ${profile.email} → ${email.toLowerCase()}`,
)
