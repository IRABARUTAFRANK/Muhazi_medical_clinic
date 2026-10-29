// Muhazi Medical Clinic System — Edge Function `visit-edit-code`
// A finished visit is locked (0104). To edit it, the clinician gives a reason and receives a
// 6-digit code by e-mail; typed back in the app (verify_visit_edit, called by the browser), it
// opens a 30-minute edit window. This function is the only place that sees the plain code: it
// checks the caller's session, asks the database for a code with the service role
// (request_visit_edit returns the plain code to the service role only) and e-mails it to the
// caller's own address through Resend or Brevo, as `send-auth-email` does.
//
//   Deploy:  pnpm sb:deploy visit-edit-code
//            (npx supabase functions deploy visit-edit-code --no-verify-jwt --project-ref <ref>)
//   Secrets: RESEND_API_KEY or BREVO_API_KEY, MAIL_FROM (the same as send-auth-email);
//            SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided.
//
// Every call carries the caller's Supabase session token; the database decides who may edit
// (a clinician who treated the patient, or the manager) and limits to 5 codes per visit and
// 10 minutes. Body: { action: 'request', encounter_id, reason }.
import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY')!
const SERVICE_KEY =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY')!
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY')
const MAIL_FROM = Deno.env.get('MAIL_FROM') ?? 'Muhazi Medical Clinic <onboarding@resend.dev>'
const CLINIC = 'Muhazi Medical Clinic'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

const parseFrom = (from: string): { name: string; email: string } => {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/)
  return m ? { name: m[1] || CLINIC, email: m[2] } : { name: CLINIC, email: from.trim() }
}

async function send(to: string, subject: string, text: string, html: string): Promise<void> {
  if (RESEND_API_KEY) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text, html }),
    })
    if (!r.ok) throw new Error(`resend ${r.status}: ${await r.text()}`)
    return
  }
  if (BREVO_API_KEY) {
    const sender = parseFrom(MAIL_FROM)
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender,
        to: [{ email: to }],
        subject,
        textContent: text,
        htmlContent: html,
      }),
    })
    if (!r.ok) throw new Error(`brevo ${r.status}: ${await r.text()}`)
    return
  }
  throw new Error('no mail provider configured (RESEND_API_KEY or BREVO_API_KEY)')
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

const codeMail = (code: string, visit: string, patient: string, reason: string) => {
  const what = `${visit}${patient ? ` (${patient})` : ''}`
  return {
    subject: `${code} is your ${CLINIC} code to edit visit ${visit}`,
    text: `Your ${CLINIC} code to edit the finished visit ${what} is ${code}. It expires in 10 minutes; once typed, the visit can be edited for 30 minutes. Reason given: ${reason}. If you did not ask for it, tell the clinic manager.`,
    html: `<div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#0b2252">
  <h2 style="margin:0 0 8px">${CLINIC}</h2>
  <p style="margin:0 0 16px">Your code to edit the finished visit <strong>${esc(what)}</strong>:</p>
  <p style="font-size:32px;font-weight:800;letter-spacing:.3em;margin:0 0 16px">${code}</p>
  <p style="margin:0 0 8px;color:#4b5a78">It expires in 10 minutes; once typed, the visit can be edited for 30 minutes.</p>
  <p style="margin:0 0 8px;color:#4b5a78">Reason given: ${esc(reason)}</p>
  <p style="margin:0;color:#4b5a78">If you did not ask for it, tell the clinic manager.</p>
</div>`,
  }
}

interface Body {
  action: 'request'
  encounter_id: string
  reason: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json(405, { error: 'POST only' })

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Who is calling? A signed-in, active staff member.
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return json(401, { error: 'not signed in' })
  const { data: caller, error: callerError } = await admin.auth.getUser(token)
  if (callerError || !caller.user) return json(401, { error: 'session expired, sign in again' })
  const { data: me } = await admin
    .from('profiles')
    .select('active, email, full_name')
    .eq('id', caller.user.id)
    .maybeSingle()
  if (!me?.active) return json(403, { error: 'not allowed' })

  // The session must be approved by the database (0081): opened by the e-mailed code or a valid
  // browser key, and active within the hours without activity (as manage-staff checks).
  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
  const { data: status, error: statusError } = await asCaller.rpc('session_status')
  if (statusError && statusError.code === 'PT401') {
    return json(401, {
      error: 'sign-in not approved: sign in again with the e-mailed code',
      reason: statusError.hint || 'code_required',
    })
  }
  if (statusError && statusError.code !== 'PGRST202') return json(503, { error: 'try again' })
  const session = status as { ok?: boolean; reason?: string } | null
  if (!statusError && session?.ok !== true) {
    return json(401, {
      error: 'sign-in not approved: sign in again with the e-mailed code',
      reason: session?.reason ?? 'code_required',
    })
  }

  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return json(400, { error: 'invalid JSON' })
  }
  if (body.action !== 'request') return json(400, { error: 'unknown action' })
  if (!UUID.test(body.encounter_id ?? '')) return json(400, { error: 'invalid visit' })
  const reason = (body.reason ?? '').trim().slice(0, 500)

  const myEmail = caller.user.email ?? me.email
  if (!myEmail) return json(400, { error: 'no e-mail on your account' })

  // The database makes the code and keeps only its hash; the plain code comes back to the
  // service role only, never to the browser.
  const { data: grant, error: grantError } = await admin.rpc('request_visit_edit', {
    p_encounter_id: body.encounter_id,
    p_reason: reason,
    p_user_id: caller.user.id,
  })
  if (grantError) {
    const e = grantError as { code?: string; message?: string; hint?: string }
    return json(e.code === '42501' ? 403 : 400, {
      error: e.message ?? 'refused',
      code: e.code ?? null,
      hint: e.hint ?? null,
    })
  }
  const g = grant as { id?: string; code?: string; codeUntil?: string } | null
  if (!g?.id || !g.code) return json(500, { error: 'no code made' })

  // The visit's reference and the patient's name, for the e-mail (the service role reads them).
  const { data: enc } = await admin
    .from('encounter')
    .select('reference, patient:patient_id(surname, given_names)')
    .eq('id', body.encounter_id)
    .maybeSingle()
  const p = (Array.isArray(enc?.patient) ? enc?.patient[0] : enc?.patient) as {
    surname?: string
    given_names?: string
  } | null
  const visitRef = (enc?.reference as string | null) ?? body.encounter_id.slice(0, 8)
  const patientName = p ? `${p.surname ?? ''} ${p.given_names ?? ''}`.trim() : ''

  try {
    const m = codeMail(g.code, visitRef, patientName, reason)
    await send(myEmail, m.subject, m.text, m.html)
  } catch (e) {
    return json(502, { error: 'code_send_failed', detail: (e as Error).message })
  }
  return json(200, {
    ok: true,
    grantId: g.id,
    codeUntil: g.codeUntil ?? null,
    masked: mask(myEmail),
  })
})
