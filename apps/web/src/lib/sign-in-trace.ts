/*
 * Sign-in trace (for support). Some staff are sent back to the PIN step a few seconds after the
 * e-mailed code was accepted, while the server shows a healthy sign-in. To see what the browser
 * did, this tab keeps a short log of the sign-in in localStorage (`mmc.signin-trace`, the last
 * 150 lines, shared by the tabs of this browser): Supabase Auth events, each sign-in step and
 * its outcome, every sign-out and why, refusals of the database, writes and removals of the
 * tab's sign-in in storage, page lifecycle and route changes.
 *
 * Never written: the PIN, the e-mailed code, access or refresh tokens, browser keys. A session is
 * only described by its `session_id` claim and when it expires.
 *
 * Support reads it in the browser console with `mmcSignInTrace()`. When a tab loses its
 * signed-in person without the person choosing it, the trace is also sent to the server
 * (report_client_event, see lib/supabase.ts).
 */

const KEY = 'mmc.signin-trace'
const MAX_LINES = 150
/** The report sent to the server stays under this size (the server refuses more). */
export const TRACE_REPORT_BYTES = 8 * 1024

/** This tab, as named in the trace (several tabs of one browser write into the same log). */
let tabLabel = '?'
export function setTraceTab(id: string) {
  tabLabel = id
}

const read = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((l): l is string => typeof l === 'string') : []
  } catch {
    return []
  }
}

const clip = (v: unknown): unknown =>
  typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v

/** Adds one line to the trace. `detail` holds small values only (never secrets). */
export function trace(what: string, detail?: Record<string, unknown>): void {
  try {
    let line = `${new Date().toISOString()} [${tabLabel}] ${what}`
    if (detail) {
      const clean: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(detail)) if (v !== undefined) clean[k] = clip(v)
      line += ' ' + JSON.stringify(clean)
    }
    const lines = read()
    lines.push(line)
    localStorage.setItem(KEY, JSON.stringify(lines.slice(-MAX_LINES)))
  } catch {
    /* storage blocked or full: the trace is only a help */
  }
}

/** The trace, oldest line first. */
export function traceLines(): string[] {
  return read()
}

/** The latest lines that fit in `bytes` (UTF-8), oldest first. */
export function traceTail(bytes = TRACE_REPORT_BYTES): string[] {
  const out: string[] = []
  let size = 2
  const enc = new TextEncoder()
  const lines = read()
  for (let i = lines.length - 1; i >= 0; i--) {
    const n = enc.encode(JSON.stringify(lines[i])).length + 1
    if (size + n > bytes) break
    size += n
    out.unshift(lines[i]!)
  }
  return out
}

/** A few frames of the current call stack, for the lines that need to say who did it. */
export function shortStack(skip = 2): string {
  try {
    const frames = (new Error().stack ?? '')
      .split('\n')
      .slice(skip)
      .map((f) =>
        f
          .trim()
          .replace(/^at\s+/, '')
          // keep the file name, not the full address
          .replace(/\(?(https?:\/\/[^)\s]*\/)([^/)\s]+)\)?/g, (_m, _base: string, file: string) =>
            file.replace(/\?[^:]*/, ''),
          ),
      )
      .filter(Boolean)
      .slice(0, 6)
    return frames.join(' < ')
  } catch {
    return ''
  }
}

/** What may be said about a session: its `session_id` claim and when it expires. */
export function describeSession(
  session: { access_token?: string; expires_at?: number } | null | undefined,
): { sid: string | null; exp: string | null } | null {
  if (!session) return null
  let sid: string | null = null
  try {
    const part = session.access_token?.split('.')[1]
    if (part) {
      const claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as {
        session_id?: unknown
      }
      sid = typeof claims.session_id === 'string' ? claims.session_id : null
    }
  } catch {
    sid = null
  }
  const exp = typeof session.expires_at === 'number' ? isoTime(session.expires_at * 1000) : null
  return { sid, exp }
}

/** The same, for a session as stored by Supabase Auth (a JSON string). */
export function describeStoredSession(value: string | null | undefined) {
  if (!value) return null
  try {
    return describeSession(JSON.parse(value) as { access_token?: string; expires_at?: number })
  } catch {
    return { sid: null, exp: null, unreadable: true }
  }
}

/** A time as ISO text, or null when there is none or it is not a valid time (never throws). */
export function isoTime(ms: number | null | undefined): string | null {
  try {
    return ms ? new Date(ms).toISOString() : null
  } catch {
    return null
  }
}

/**
 * What the trace may say about an address: the path only. The query string can carry patient
 * data (the top-bar search puts the typed text in `/app/patients?q=…`, a record or a visit its
 * id), so it is dropped, except the staff ID of the sign-in page (`/login?staff=…`). The part
 * after `#` (a sign-in link carries tokens there) is never kept.
 */
export function safePath(pathname: string, search: string): string {
  let s = ''
  try {
    const staff = new URLSearchParams(search).get('staff')
    if (staff && /^[A-Za-z0-9-]{1,20}$/.test(staff)) s = `?staff=${staff}`
  } catch {
    s = ''
  }
  return pathname + s
}

/** This page's address, as the trace may say it (see safePath). */
export const tracePath = () =>
  typeof window === 'undefined' ? '' : safePath(window.location.pathname, window.location.search)

declare global {
  interface Window {
    /** Support: the sign-in trace of this browser (see lib/sign-in-trace.ts). */
    mmcSignInTrace?: () => string[]
  }
}

let started = false
/**
 * Page lifecycle in the trace: how the page was loaded, hidden, shown, frozen and resumed.
 * Runs once per page.
 */
export function startTrace(): void {
  if (started || typeof window === 'undefined') return
  started = true
  window.mmcSignInTrace = traceLines
  let navType: string | undefined
  try {
    navType = (
      performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    )?.type
  } catch {
    navType = undefined
  }
  trace('page.load', { type: navType, path: tracePath(), visible: document.visibilityState })
  window.addEventListener('pagehide', (e) => trace('page.hide', { persisted: e.persisted }))
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) trace('page.show', { persisted: true, path: tracePath() })
  })
  document.addEventListener('visibilitychange', () =>
    trace('page.visibility', { state: document.visibilityState }),
  )
  document.addEventListener('freeze', () => trace('page.freeze'))
  document.addEventListener('resume', () => trace('page.resume'))
}
