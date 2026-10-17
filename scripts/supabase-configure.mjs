/**
 * Applies the Supabase Auth settings the staff sign-in needs, through the Management API:
 *   - sign-ups off, e-mail confirmation off, minimum password (PIN) length 6
 *   - site URL and allowed redirect = the public web app
 *   - Magic Link template carries the six-digit code ({{ .Token }}), length 6, expiry 10 min
 *   - optional custom SMTP (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SENDER, SMTP_ADMIN_EMAIL)
 *   - the "Send Email" hook → send-auth-email function, when a mail provider key exists
 *     (RESEND_API_KEY or BREVO_API_KEY, optional MAIL_FROM); the hook secret and provider
 *     keys are stored as function secrets.
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_… node scripts/supabase-configure.mjs [--dry-run]
 *   (everything can live in the root .env; this script reads it)
 */
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
for (const file of ['.env', 'apps/web/.env.local']) {
  try {
    const env = await readFile(path.join(root, file), 'utf8')
    for (const line of env.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1')
    }
  } catch {
    /* optional */
  }
}

const token = process.env.SUPABASE_ACCESS_TOKEN
const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const ref = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1]
const siteUrl = process.env.SITE_URL || 'https://muhazimedicalclinicltd.vercel.app'
const dryRun = process.argv.includes('--dry-run')
if (!token || !ref) {
  console.error(
    'Set SUPABASE_ACCESS_TOKEN (dashboard → Account → Access Tokens) and SUPABASE_URL in .env first.',
  )
  process.exit(1)
}

const api = async (method, p, body) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

const current = await api('GET', '/config/auth')
console.log('current:', {
  site_url: current.site_url,
  disable_signup: current.disable_signup,
  mailer_autoconfirm: current.mailer_autoconfirm,
  password_min_length: current.password_min_length,
  mailer_otp_length: current.mailer_otp_length,
  mailer_otp_exp: current.mailer_otp_exp,
  smtp_host: current.smtp_host,
  hook_send_email_enabled: current.hook_send_email_enabled,
  template_has_token: /\{\{\s*\.Token\s*\}\}/.test(
    current.mailer_templates_magic_link_content ?? '',
  ),
})

const magicLink = `<div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#0b2252">
  <h2 style="margin:0 0 8px">Muhazi Medical Clinic</h2>
  <p style="margin:0 0 16px">Your sign-in code:</p>
  <p style="font-size:32px;font-weight:800;letter-spacing:.3em;margin:0 0 16px">{{ .Token }}</p>
  <p style="margin:0;color:#4b5a78">It expires in 10 minutes. If you did not try to sign in, tell the clinic manager.</p>
</div>`

const allow = new Set(
  (current.uri_allow_list ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)
allow.add(siteUrl)
allow.add(`${siteUrl}/**`)
allow.add('http://localhost:5173/**')

const patch = {
  disable_signup: true,
  mailer_autoconfirm: true,
  password_min_length: 6,
  site_url: siteUrl,
  uri_allow_list: [...allow].join(','),
  mailer_subjects_magic_link: '{{ .Token }} is your Muhazi Medical Clinic sign-in code',
  mailer_templates_magic_link_content: magicLink,
  mailer_otp_length: 6,
  mailer_otp_exp: 600,
}

// Optional custom SMTP (used by Supabase's own mailer when the hook is off).
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  Object.assign(patch, {
    smtp_host: process.env.SMTP_HOST,
    smtp_port: process.env.SMTP_PORT || '587',
    smtp_user: process.env.SMTP_USER,
    smtp_pass: process.env.SMTP_PASS,
    smtp_sender_name: process.env.SMTP_SENDER || 'Muhazi Medical Clinic',
    smtp_admin_email: process.env.SMTP_ADMIN_EMAIL || process.env.SMTP_USER,
    rate_limit_email_sent: 60,
  })
  console.log('smtp: will set custom SMTP', process.env.SMTP_HOST)
} else {
  console.log('smtp: no SMTP_* in .env — Supabase built-in sender stays (a few mails per hour)')
}

// Send Email hook → our function, only when it can actually send mail.
const provider = process.env.RESEND_API_KEY ? 'resend' : process.env.BREVO_API_KEY ? 'brevo' : null
let hookSecret = null
if (provider) {
  hookSecret =
    current.hook_send_email_enabled && process.env.SEND_EMAIL_HOOK_SECRET
      ? process.env.SEND_EMAIL_HOOK_SECRET
      : `v1,whsec_${randomBytes(32).toString('base64')}`
  Object.assign(patch, {
    hook_send_email_enabled: true,
    hook_send_email_uri: `https://${ref}.supabase.co/functions/v1/send-auth-email`,
    hook_send_email_secrets: hookSecret,
    rate_limit_email_sent: 60,
  })
  console.log(`hook: will enable send-auth-email via ${provider}`)
} else {
  console.log(
    'hook: no RESEND_API_KEY / BREVO_API_KEY in .env — codes go through the Supabase mailer; PIN gating only in the app',
  )
}

if (dryRun) {
  console.log('dry run — would PATCH:', Object.keys(patch).join(', '))
  process.exit(0)
}

await api('PATCH', '/config/auth', patch)
console.log('auth config updated')

if (provider) {
  const secrets = [{ name: 'SEND_EMAIL_HOOK_SECRET', value: hookSecret }]
  if (process.env.RESEND_API_KEY)
    secrets.push({ name: 'RESEND_API_KEY', value: process.env.RESEND_API_KEY })
  if (process.env.BREVO_API_KEY)
    secrets.push({ name: 'BREVO_API_KEY', value: process.env.BREVO_API_KEY })
  if (process.env.MAIL_FROM) secrets.push({ name: 'MAIL_FROM', value: process.env.MAIL_FROM })
  await api('POST', '/secrets', secrets)
  console.log('function secrets set:', secrets.map((s) => s.name).join(', '))
  console.log('keep SEND_EMAIL_HOOK_SECRET in .env to reuse it:', hookSecret)
}

const after = await api('GET', '/config/auth')
console.log('now:', {
  disable_signup: after.disable_signup,
  mailer_otp_length: after.mailer_otp_length,
  mailer_otp_exp: after.mailer_otp_exp,
  smtp_host: after.smtp_host,
  hook_send_email_enabled: after.hook_send_email_enabled,
  template_has_token: /\{\{\s*\.Token\s*\}\}/.test(after.mailer_templates_magic_link_content ?? ''),
})
