// Muhazi Medical Clinic System — Edge Function `manage-staff`
// The only place that touches Supabase Auth with the service role. It lets the clinic manager
// create employee accounts, hand over or reset a PIN, and deactivate or reactivate an employee.
//
//   Deploy:  npx supabase functions deploy manage-staff --project-ref wwxmdqdrdekpzcbijsqo
//   Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//
// Each employee has a real e-mail address (the sign-in code is sent there) and a staff ID that
// the database assigns (MMC-S-0001). The manager sets the username, the first PIN and the e-mail.
//
// Every call must carry the caller's Supabase session token; the caller must be an active manager.
import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY')!

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
const USERNAME = /^[a-z0-9._-]{3,32}$/
const PIN = /^[0-9]{6}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const BAN_FOREVER = '876000h'

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

type Body =
  | {
      action: 'create'
      username: string
      full_name: string
      role: string
      pin: string
      /** Where the sign-in code is sent. Required: the second sign-in step depends on it. */
      email: string
      station?: string
      dashboard?: 'manager' | 'head' | null
      head_of?: string
      language?: 'kin' | 'en' | 'fr'
      phone?: string
    }
  | { action: 'reset_pin'; user_id: string; pin: string }
  | { action: 'set_active'; user_id: string; active: boolean }
  | { action: 'set_email'; user_id: string; email: string }
  | {
      action: 'update'
      user_id: string
      full_name: string
      role: string
      station?: string
      dashboard?: 'manager' | 'head' | null
      head_of?: string
      language?: 'kin' | 'en' | 'fr'
      phone?: string
    }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json(405, { error: 'POST only' })

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Who is calling? Must be a signed-in, active manager.
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return json(401, { error: 'not signed in' })
  const { data: caller, error: callerError } = await admin.auth.getUser(token)
  if (callerError || !caller.user) return json(401, { error: 'session expired, sign in again' })
  const { data: me } = await admin
    .from('profiles')
    .select('role, active')
    .eq('id', caller.user.id)
    .maybeSingle()
  if (!me?.active || me.role !== 'manager') return json(403, { error: 'managers only' })

  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return json(400, { error: 'invalid JSON' })
  }

  const audit = async (action: string, entityId: string, after: unknown) => {
    await admin.from('audit_event').insert({
      actor_id: caller.user.id,
      action: 'settings',
      entity: 'profiles',
      entity_id: entityId,
      after: { manage_staff: action, ...(after as Record<string, unknown>) },
    })
  }

  switch (body.action) {
    case 'create': {
      const username = body.username?.trim().toLowerCase()
      if (!USERNAME.test(username ?? ''))
        return json(400, {
          error: 'username: 3–32 lowercase letters, digits, dot, dash or underscore',
        })
      if (!PIN.test(body.pin ?? '')) return json(400, { error: 'PIN must be six digits' })
      if (!ROLES.includes(body.role)) return json(400, { error: 'unknown role' })
      if (!body.full_name?.trim()) return json(400, { error: 'full name is required' })
      const email = body.email?.trim().toLowerCase()
      if (!EMAIL.test(email ?? ''))
        return json(400, { error: 'a valid e-mail address is required' })
      if (body.dashboard && !['manager', 'head'].includes(body.dashboard))
        return json(400, { error: 'dashboard must be manager or head' })
      const { data: taken } = await admin
        .from('profiles')
        .select('id')
        .eq('username', username)
        .maybeSingle()
      if (taken) return json(409, { error: 'username already exists' })
      const { data: emailTaken } = await admin
        .from('profiles')
        .select('id')
        .eq('email', email)
        .maybeSingle()
      if (emailTaken) return json(409, { error: 'e-mail already used by another employee' })
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password: body.pin,
        email_confirm: true,
        user_metadata: {
          username,
          full_name: body.full_name.trim(),
          role: body.role,
          station: body.station || null,
          dashboard: body.dashboard || null,
          head_of: body.head_of || null,
          language: body.language ?? 'kin',
          phone: body.phone || null,
          must_change_pin: true,
          created_by: caller.user.id,
        },
      })
      if (error) return json(400, { error: error.message })
      // The staff ID is assigned by the database when the profile row is created.
      const { data: created } = await admin
        .from('profiles')
        .select('staff_id')
        .eq('id', data.user.id)
        .maybeSingle()
      await audit('create', data.user.id, {
        username,
        role: body.role,
        staff_id: created?.staff_id,
      })
      return json(200, { id: data.user.id, username, staff_id: created?.staff_id ?? null, email })
    }

    case 'set_email': {
      const email = body.email?.trim().toLowerCase()
      if (!EMAIL.test(email ?? ''))
        return json(400, { error: 'a valid e-mail address is required' })
      const { data: emailTaken } = await admin
        .from('profiles')
        .select('id')
        .eq('email', email)
        .neq('id', body.user_id)
        .maybeSingle()
      if (emailTaken) return json(409, { error: 'e-mail already used by another employee' })
      const { error } = await admin.auth.admin.updateUserById(body.user_id, {
        email,
        email_confirm: true,
      })
      if (error) return json(400, { error: error.message })
      await admin.from('profiles').update({ email }).eq('id', body.user_id)
      await audit('set_email', body.user_id, { email })
      return json(200, { ok: true })
    }

    case 'reset_pin': {
      if (!PIN.test(body.pin ?? '')) return json(400, { error: 'PIN must be six digits' })
      const { error } = await admin.auth.admin.updateUserById(body.user_id, { password: body.pin })
      if (error) return json(400, { error: error.message })
      await admin.from('profiles').update({ must_change_pin: true }).eq('id', body.user_id)
      await audit('reset_pin', body.user_id, {})
      return json(200, { ok: true })
    }

    case 'set_active': {
      if (body.user_id === caller.user.id && !body.active)
        return json(400, { error: 'you cannot deactivate your own account' })
      // A banned user cannot sign in or refresh a session; the profile flag blocks RLS-level access.
      const { error } = await admin.auth.admin.updateUserById(body.user_id, {
        ban_duration: body.active ? 'none' : BAN_FOREVER,
      })
      if (error) return json(400, { error: error.message })
      await admin
        .from('profiles')
        .update({
          active: body.active,
          deactivated_at: body.active ? null : new Date().toISOString(),
        })
        .eq('id', body.user_id)
      await audit('set_active', body.user_id, { active: body.active })
      return json(200, { ok: true })
    }

    case 'update': {
      if (!ROLES.includes(body.role)) return json(400, { error: 'unknown role' })
      if (body.dashboard && !['manager', 'head'].includes(body.dashboard))
        return json(400, { error: 'dashboard must be manager or head' })
      const { error } = await admin
        .from('profiles')
        .update({
          full_name: body.full_name.trim(),
          role: body.role,
          station: body.station || null,
          dashboard: body.dashboard || null,
          head_of: body.head_of || null,
          language: body.language ?? 'kin',
          phone: body.phone || null,
        })
        .eq('id', body.user_id)
      if (error) return json(400, { error: error.message })
      await admin.auth.admin.updateUserById(body.user_id, {
        user_metadata: {
          full_name: body.full_name.trim(),
          role: body.role,
          station: body.station || null,
        },
      })
      await audit('update', body.user_id, { role: body.role, station: body.station })
      return json(200, { ok: true })
    }

    default:
      return json(400, { error: 'unknown action' })
  }
})
