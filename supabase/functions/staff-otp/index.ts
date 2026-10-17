// Muhazi Medical Clinic System — Edge Function `staff-otp`
// Step 2 of the staff sign-in, done on the server so the PIN is always checked before a code
// can go out: staff ID + username → e-mail; PIN verified with Supabase Auth; a login request is
// recorded; then Supabase Auth is asked to send the one-time code (through the
// `send-auth-email` hook when it is enabled, otherwise through the project's mailer).
//
//   Deploy:  npx supabase functions deploy staff-otp --no-verify-jwt --project-ref <ref>
//   Secrets: SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided.
//
// Public endpoint (no session yet). Abuse limits: 5 requests per account per 10 minutes.
import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY')!
const SERVICE_KEY =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY')!

const STAFF_ID = /^MMC-S-[0-9]{4}$/
const USERNAME = /^[a-z0-9._-]{3,32}$/
const PIN = /^[0-9]{6}$/
const MAX_PER_WINDOW = 5
const WINDOW_MS = 10 * 60_000

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })

const mask = (email: string) => {
  const [local = '', domain = ''] = email.split('@')
  return `${local.slice(0, 2)}${'•'.repeat(Math.max(3, local.length - 2))}@${domain}`
}

interface Body {
  action: 'request'
  staff_id: string
  username: string
  pin: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json(405, { error: 'POST only' })

  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return json(400, { error: 'invalid JSON' })
  }
  if (body.action !== 'request') return json(400, { error: 'unknown action' })
  const staffId = (body.staff_id ?? '').trim().toUpperCase()
  const username = (body.username ?? '').trim().toLowerCase()
  if (!STAFF_ID.test(staffId) || !USERNAME.test(username) || !PIN.test(body.pin ?? '')) {
    return json(401, { error: 'invalid' })
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: profile } = await admin
    .from('profiles')
    .select('id, email, active')
    .eq('staff_id', staffId)
    .eq('username', username)
    .maybeSingle()
  if (!profile || !profile.email) return json(401, { error: 'invalid' })
  if (!profile.active) return json(403, { error: 'inactive' })

  // Abuse limit per account.
  const since = new Date(Date.now() - WINDOW_MS).toISOString()
  const { count } = await admin
    .from('login_request')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', profile.id)
    .gte('requested_at', since)
  if ((count ?? 0) >= MAX_PER_WINDOW) return json(429, { error: 'too_many' })

  // The PIN is checked by Supabase Auth; the session it returns is discarded.
  const verifier = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error: pinError } = await verifier.auth.signInWithPassword({
    email: profile.email,
    password: body.pin,
  })
  if (pinError) {
    await admin.from('audit_event').insert({
      actor_id: profile.id,
      action: 'login',
      entity: 'profiles',
      entity_id: profile.id,
      reason: 'wrong PIN (staff-otp)',
    })
    return json(/banned/i.test(pinError.message) ? 403 : 401, {
      error: /banned/i.test(pinError.message) ? 'inactive' : 'invalid',
    })
  }
  await verifier.auth.signOut()

  // PIN accepted: record the request, then ask Auth to send the code.
  const { error: reqError } = await admin.from('login_request').insert({
    user_id: profile.id,
    email: profile.email,
    client: (req.headers.get('user-agent') ?? '').slice(0, 120),
  })
  if (reqError) return json(500, { error: reqError.message })

  const sender = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error: otpError } = await sender.auth.signInWithOtp({
    email: profile.email,
    options: { shouldCreateUser: false },
  })
  if (otpError) return json(502, { error: 'otp_send_failed', detail: otpError.message })

  return json(200, { ok: true, email: profile.email, masked: mask(profile.email) })
})
