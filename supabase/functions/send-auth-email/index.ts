// Muhazi Medical Clinic System — Edge Function `send-auth-email`
// Supabase Auth "Send Email" hook. When enabled, Supabase sends no e-mail itself: it calls this
// function with the message data and we send it through Resend or Brevo. For sign-in codes
// (magic link type) we only send when `staff-otp` recorded a PIN-verified login request in the
// last three minutes — so nobody can obtain a code without the PIN, even by calling
// signInWithOtp directly.
//
//   Deploy:  npx supabase functions deploy send-auth-email --no-verify-jwt --project-ref <ref>
//   Secrets: SEND_EMAIL_HOOK_SECRET (the "v1,whsec_…" value from the hook config),
//            RESEND_API_KEY or BREVO_API_KEY, MAIL_FROM (e.g. "Muhazi Medical Clinic <no-reply@…>")
//            SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { Webhook } from 'npm:standardwebhooks@1.0.0'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY')!
const HOOK_SECRET = Deno.env.get('SEND_EMAIL_HOOK_SECRET') ?? ''
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY')
const MAIL_FROM = Deno.env.get('MAIL_FROM') ?? 'Muhazi Medical Clinic <onboarding@resend.dev>'
const CLINIC = 'Muhazi Medical Clinic'
const REQUEST_MAX_AGE_MS = 3 * 60_000

interface HookPayload {
  user: { id: string; email: string }
  email_data: {
    token: string
    token_hash: string
    redirect_to: string
    email_action_type:
      'signup' | 'invite' | 'magiclink' | 'recovery' | 'email_change' | 'email' | 'reauthentication'
    site_url: string
    token_new?: string
    token_hash_new?: string
  }
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

const codeMail = (code: string) => ({
  subject: `${code} is your ${CLINIC} sign-in code`,
  text: `Your ${CLINIC} sign-in code is ${code}. It expires in 10 minutes. If you did not try to sign in, tell the clinic manager.`,
  html: `<div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#0b2252">
  <h2 style="margin:0 0 8px">${CLINIC}</h2>
  <p style="margin:0 0 16px">Your sign-in code:</p>
  <p style="font-size:32px;font-weight:800;letter-spacing:.3em;margin:0 0 16px">${code}</p>
  <p style="margin:0;color:#4b5a78">It expires in 10 minutes. If you did not try to sign in, tell the clinic manager.</p>
</div>`,
})

const linkMail = (subject: string, intro: string, url: string) => ({
  subject,
  text: `${intro}\n\n${url}`,
  html: `<div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#0b2252">
  <h2 style="margin:0 0 8px">${CLINIC}</h2>
  <p>${intro}</p>
  <p><a href="${url}" style="display:inline-block;background:#0b5fff;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">Continue</a></p>
  <p style="color:#4b5a78;font-size:13px">${url}</p>
</div>`,
})

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 })
  const raw = await req.text()

  // Verify the hook signature (Standard Webhooks).
  let payload: HookPayload
  try {
    const wh = new Webhook(HOOK_SECRET.replace(/^v1,whsec_/, ''))
    payload = wh.verify(raw, {
      'webhook-id': req.headers.get('webhook-id') ?? '',
      'webhook-timestamp': req.headers.get('webhook-timestamp') ?? '',
      'webhook-signature': req.headers.get('webhook-signature') ?? '',
    }) as HookPayload
  } catch (e) {
    return new Response(JSON.stringify({ error: `bad signature: ${(e as Error).message}` }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { user, email_data: d } = payload
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  try {
    if (d.email_action_type === 'magiclink') {
      // Only after staff-otp verified the PIN.
      const since = new Date(Date.now() - REQUEST_MAX_AGE_MS).toISOString()
      const { data: request } = await admin
        .from('login_request')
        .select('id')
        .eq('user_id', user.id)
        .is('consumed_at', null)
        .gte('requested_at', since)
        .order('requested_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!request) {
        await admin.from('audit_event').insert({
          actor_id: user.id,
          action: 'login',
          entity: 'profiles',
          entity_id: user.id,
          reason: 'code requested without PIN — not sent',
        })
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      await admin
        .from('login_request')
        .update({ consumed_at: new Date().toISOString() })
        .eq('id', request.id)
      const m = codeMail(d.token)
      await send(user.email, m.subject, m.text, m.html)
    } else {
      const confirm = `${d.site_url.replace(/\/$/, '')}/auth/confirm?token_hash=${d.token_hash}&type=${d.email_action_type}`
      const intro: Record<string, string> = {
        recovery: 'Use this link to reset your PIN.',
        email_change: 'Confirm your new e-mail address.',
        signup: 'Confirm your e-mail address.',
        invite: 'You have been invited.',
        email: 'Confirm your e-mail address.',
        reauthentication: `Your confirmation code is ${d.token}.`,
      }
      const m = linkMail(`${CLINIC}: action required`, intro[d.email_action_type] ?? '', confirm)
      await send(user.email, m.subject, m.text, m.html)
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    return new Response(
      JSON.stringify({ error: { http_code: 500, message: (e as Error).message } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
})
