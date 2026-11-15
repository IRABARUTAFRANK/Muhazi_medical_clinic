// Muhazi Medical Clinic System — Edge Function `rw-voice` (0165)
// The waiting-room TV asks for a Kinyarwanda sentence as audio: this function checks the TV's
// key (display_key_ok, service role), looks the sentence up in voice_cache, else asks the
// clinic's voice server (services/kinya-voice: POST /tts → WAV), stores the WAV in the public
// bucket "voice" under tts/<sha256>.wav and remembers it. The TV plays the returned URL.
//
//   Deploy:  pnpm sb:deploy rw-voice   (--no-verify-jwt: the TV is not signed in)
//   Secrets: VOICE_SERVER_URL (https://…, no trailing slash), VOICE_SERVER_KEY;
//            SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided.
//
// Body: { key, text }. Answer: { url } or { error }. At most 120 new sentences an hour per
// TV; a sentence is 300 characters at most.
import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY')!
const SERVER_URL = (Deno.env.get('VOICE_SERVER_URL') ?? '').replace(/\/+$/, '')
const SERVER_KEY = Deno.env.get('VOICE_SERVER_KEY') ?? ''
const BUCKET = 'voice'

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

const sha256 = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

// a small in-memory count per key, enough to stop a runaway TV
const asked = new Map<string, { n: number; since: number }>()
const tooMany = (key: string) => {
  const now = Date.now()
  const a = asked.get(key)
  if (!a || now - a.since > 3_600_000) {
    asked.set(key, { n: 1, since: now })
    return false
  }
  a.n += 1
  return a.n > 120
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json(405, { error: 'POST only' })
  let body: { key?: unknown; text?: unknown }
  try {
    body = await req.json()
  } catch {
    return json(400, { error: 'bad json' })
  }
  const key = typeof body.key === 'string' ? body.key : ''
  const text = typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : ''
  if (!/^[a-z0-9]{1,128}$/i.test(key) || !text || text.length > 300)
    return json(400, { error: 'key and text (300 characters at most)' })
  if (!SERVER_URL || !SERVER_KEY) return json(503, { error: 'no voice server configured' })

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  const ok = await admin.rpc('display_key_ok', { p_key: key })
  if (ok.error || ok.data !== true) return json(403, { error: 'unknown screen' })

  const hash = await sha256(text.toLowerCase())
  const path = `tts/${hash}.wav`
  const publicUrl = () => admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl
  const hit = await admin.from('voice_cache').select('path').eq('hash', hash).maybeSingle()
  if (hit.data) return json(200, { url: publicUrl(), cached: true })
  if (tooMany(key)) return json(429, { error: 'too many new sentences; try later' })

  // the voice server, with a time limit the TV can live with
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 25_000)
  let wav: ArrayBuffer
  try {
    const r = await fetch(`${SERVER_URL}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Key': SERVER_KEY },
      body: JSON.stringify({ text }),
      signal: ctl.signal,
    })
    if (!r.ok) return json(502, { error: `voice server ${r.status}` })
    wav = await r.arrayBuffer()
  } catch (e) {
    return json(504, { error: `voice server unreachable: ${String(e).slice(0, 120)}` })
  } finally {
    clearTimeout(timer)
  }
  if (wav.byteLength < 1_000) return json(502, { error: 'empty audio' })

  const up = await admin.storage
    .from(BUCKET)
    .upload(path, new Uint8Array(wav), { contentType: 'audio/wav', upsert: true })
  if (up.error) return json(500, { error: `store: ${up.error.message}` })
  await admin.from('voice_cache').upsert({ hash, path })
  return json(200, { url: publicUrl(), cached: false })
})
