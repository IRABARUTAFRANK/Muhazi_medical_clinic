// Muhazi Medical Clinic System — Edge Function `manage-staff`
// The only place that touches Supabase Auth with the service role. It lets the clinic manager
// create employee accounts, edit them (name, username, e-mail, role, department and position),
// hand over or reset a PIN, and deactivate or reactivate an employee.
//
//   Deploy:  pnpm sb:deploy   (npx supabase functions deploy manage-staff …)
//   Secrets: SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided.
//
// Every call must carry the caller's Supabase session token; the caller must be an active
// manager. Every change except a PIN reset also carries `confirm_code`: a one-time code e-mailed to the manager
// (action `send_code`) and checked here on the server, so each change is knowingly approved by
// the person who owns that inbox (accountability).
import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY')!

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
const POSITIONS = ['head', 'assistant', 'member']
const USERNAME = /^[a-z0-9._-]{3,32}$/
const PIN = /^[0-9]{6}$/
const CODE = /^[0-9]{6,10}$/
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

interface Assignment {
  role: string
  station?: string | null
  department_id?: string | null
  position?: 'head' | 'assistant' | 'member'
  language?: 'kin' | 'en' | 'fr'
  phone?: string | null
  /** Only for role manager: full dashboard. */
  dashboard?: 'manager' | 'head' | null
}
type Body = { confirm_code?: string } & (
  | { action: 'send_code' }
  | ({
      action: 'create'
      username: string
      full_name: string
      pin: string
      email: string
    } & Assignment)
  | ({
      action: 'update'
      user_id: string
      full_name: string
      username: string
      email: string
    } & Assignment)
  | { action: 'reset_pin'; user_id: string; pin: string }
  | { action: 'set_active'; user_id: string; active: boolean }
  | { action: 'set_email'; user_id: string; email: string }
)

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
    .select('role, active, email')
    .eq('id', caller.user.id)
    .maybeSingle()
  if (!me?.active || me.role !== 'manager') return json(403, { error: 'managers only' })

  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return json(400, { error: 'invalid JSON' })
  }

  // Re-authentication by e-mail: `send_code` mails the manager a one-time code (the clinic's
  // sign-in code e-mail); every change then carries it and it is verified here with a throw-away
  // client (the browser session is untouched). The code must belong to the caller, and the
  // temporary session it opens is closed right away.
  const myEmail = caller.user.email ?? me.email
  const check = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  if (body.action === 'send_code') {
    if (!myEmail) return json(400, { error: 'no e-mail on your account' })
    const { error } = await check.auth.signInWithOtp({
      email: myEmail,
      options: { shouldCreateUser: false },
    })
    if (error) {
      const wait = /security purposes|rate limit|after \d+ seconds/i.test(error.message)
      return json(wait ? 429 : 502, { error: wait ? 'code_wait' : error.message })
    }
    const [name, domain] = myEmail.split('@')
    return json(200, { sent: true, to: `${name!.slice(0, 2)}***@${domain}` })
  }
  // Resetting a PIN needs no e-mailed code (Frank, 2026-10-20): the new PIN is temporary, the
  // employee must replace it at the next sign-in, and the reset is still recorded in the history.
  const needsCode = body.action !== 'reset_pin'
  if (needsCode && !CODE.test(body.confirm_code ?? ''))
    return json(401, { error: 'confirm_code_required' })
  if (needsCode) {
    const { data, error } = await check.auth.verifyOtp({
      email: myEmail!,
      token: body.confirm_code!,
      type: 'email',
    })
    if (error || data.user?.id !== caller.user.id) return json(401, { error: 'confirm_code_wrong' })
    await check.auth.signOut({ scope: 'local' })
  }

  const audit = async (action: string, entityId: string, after: unknown) => {
    await admin.from('audit_event').insert({
      actor_id: caller.user.id,
      action: 'settings',
      entity: 'profiles',
      entity_id: entityId,
      after: {
        manage_staff: action,
        confirmed_with_code: needsCode,
        ...(after as Record<string, unknown>),
      },
    })
  }

  // Department + position → the columns the app already understands (dashboard / head_of).
  const assignment = async (a: Assignment) => {
    if (!ROLES.includes(a.role)) throw new Error('unknown role')
    const position = a.position ?? 'member'
    if (!POSITIONS.includes(position)) throw new Error('unknown position')
    let deptName: string | null = null
    if (a.department_id) {
      const { data: d } = await admin
        .from('department')
        .select('name, roles, deleted_at')
        .eq('id', a.department_id)
        .maybeSingle()
      if (!d || d.deleted_at) throw new Error('department not found')
      if (Array.isArray(d.roles) && d.roles.length && !d.roles.includes(a.role))
        throw new Error('this role does not belong to that department')
      deptName = d.name
    } else if (position !== 'member') {
      throw new Error('choose a department for a head or an assistant')
    }
    const dashboard = a.role === 'manager' ? 'manager' : position === 'head' ? 'head' : null
    return {
      role: a.role,
      station: a.station || null,
      department_id: a.department_id || null,
      position,
      dashboard,
      head_of: position === 'head' ? deptName : null,
      language: a.language ?? 'kin',
      phone: a.phone || null,
    }
  }

  try {
    switch (body.action) {
      case 'create': {
        const username = body.username?.trim().toLowerCase()
        if (!USERNAME.test(username ?? ''))
          return json(400, {
            error: 'username: 3–32 lowercase letters, digits, dot, dash or underscore',
          })
        if (!PIN.test(body.pin ?? '')) return json(400, { error: 'PIN must be six digits' })
        if (!body.full_name?.trim()) return json(400, { error: 'full name is required' })
        const email = body.email?.trim().toLowerCase()
        if (!EMAIL.test(email ?? ''))
          return json(400, { error: 'a valid e-mail address is required' })
        const a = await assignment(body)
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
            role: a.role,
            station: a.station,
            dashboard: a.dashboard,
            head_of: a.head_of,
            language: a.language,
            phone: a.phone,
            must_change_pin: true,
            created_by: caller.user.id,
          },
        })
        if (error) return json(400, { error: error.message })
        // The profile row is created by a trigger; add the department placement.
        await admin
          .from('profiles')
          .update({ department_id: a.department_id, position: a.position })
          .eq('id', data.user.id)
        const { data: created } = await admin
          .from('profiles')
          .select('staff_id')
          .eq('id', data.user.id)
          .maybeSingle()
        // The first PIN stays visible to managers until the employee replaces it.
        await admin
          .from('staff_temp_pin')
          .upsert({ user_id: data.user.id, pin: body.pin, set_by: caller.user.id })
        await audit('create', data.user.id, { username, role: a.role, staff_id: created?.staff_id })
        return json(200, { id: data.user.id, username, staff_id: created?.staff_id ?? null, email })
      }

      case 'update': {
        if (!body.full_name?.trim()) return json(400, { error: 'full name is required' })
        const username = body.username?.trim().toLowerCase()
        if (!USERNAME.test(username ?? ''))
          return json(400, {
            error: 'username: 3–32 lowercase letters, digits, dot, dash or underscore',
          })
        const email = body.email?.trim().toLowerCase()
        if (!EMAIL.test(email ?? ''))
          return json(400, { error: 'a valid e-mail address is required' })
        if (body.user_id === caller.user.id && body.role !== 'manager')
          return json(400, { error: 'you cannot remove your own manager role' })
        const a = await assignment(body)
        const { data: taken } = await admin
          .from('profiles')
          .select('id')
          .eq('username', username)
          .neq('id', body.user_id)
          .maybeSingle()
        if (taken) return json(409, { error: 'username already exists' })
        const { data: emailTaken } = await admin
          .from('profiles')
          .select('id')
          .eq('email', email)
          .neq('id', body.user_id)
          .maybeSingle()
        if (emailTaken) return json(409, { error: 'e-mail already used by another employee' })
        const { data: before } = await admin
          .from('profiles')
          .select('username, email, role, department_id, position')
          .eq('id', body.user_id)
          .maybeSingle()
        if (!before) return json(404, { error: 'employee not found' })
        if (email !== before.email) {
          const { error } = await admin.auth.admin.updateUserById(body.user_id, {
            email,
            email_confirm: true,
          })
          if (error) return json(400, { error: error.message })
        }
        const { error } = await admin
          .from('profiles')
          .update({ ...a, full_name: body.full_name.trim(), username, email })
          .eq('id', body.user_id)
        if (error) return json(400, { error: error.message })
        await admin.auth.admin.updateUserById(body.user_id, {
          user_metadata: {
            username,
            full_name: body.full_name.trim(),
            role: a.role,
            station: a.station,
          },
        })
        await audit('update', body.user_id, {
          before,
          username,
          email,
          role: a.role,
          department_id: a.department_id,
          position: a.position,
        })
        return json(200, { ok: true })
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
        const { error } = await admin.auth.admin.updateUserById(body.user_id, {
          password: body.pin,
        })
        if (error) return json(400, { error: error.message })
        await admin.from('profiles').update({ must_change_pin: true }).eq('id', body.user_id)
        await admin.from('staff_temp_pin').upsert({
          user_id: body.user_id,
          pin: body.pin,
          set_by: caller.user.id,
          set_at: new Date().toISOString(),
        })
        // A new PIN also forgets the employee's trusted devices.
        await admin
          .from('trusted_device')
          .update({ revoked_at: new Date().toISOString() })
          .eq('user_id', body.user_id)
          .is('revoked_at', null)
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

      default:
        return json(400, { error: 'unknown action' })
    }
  } catch (e) {
    return json(400, { error: e instanceof Error ? e.message : String(e) })
  }
})
