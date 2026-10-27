import { useNavigate } from '@tanstack/react-router'
import { useNotificationActions, type Notice } from '@/lib/api/notifications'
import { useSession } from '@/store/session'

/*
 * Where a notice opens. The database gives each notice a `link`; some kinds only said "Home"
 * (`/app`), so the item they are about sat far below and the reader "saw nothing". The exact
 * place is worked out here from the kind and its params, falling back to the link:
 * - a visit, a patient, a stock note, a bill, a record-access request: the link already names it;
 * - an item that lives on Home (a booking to accept, a colleague's call, a task without a visit)
 *   or on the Appointments page (a booking request): `?focus=<kind>:<id>`, which scrolls that row
 *   into view and outlines it (lib/notice-focus.ts).
 */

/** The Home items a notice can point to, and the stable id of the panel that lists each. */
export const FOCUS_PANEL = {
  to_accept: 'home-to-accept',
  call: 'home-calls',
  task: 'home-tasks',
  inquiry: 'home-inquiries',
} as const
export type FocusKind = keyof typeof FOCUS_PANEL

/** The `data-focus` value of a row (`to_accept:<id>`). */
export const focusKey = (kind: FocusKind, id: string) => `${kind}:${id}`

/** The person's Home: the manager's is the dashboard (`/app` sends them there without the query). */
export const homeOf = (role: string | undefined) => (role === 'manager' ? '/app/dashboard' : '/app')

/** "2026-10-27": the day of a time in Kigali (the Appointments page opens on that day). */
const kigaliDay = (iso: string) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali' }).format(d)
}

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** The address a notice opens, or null when it is only to read (a message). */
export function noticeTarget(n: Notice, role: string | undefined): string | null {
  const p = (n.params ?? {}) as Record<string, unknown>
  const home = homeOf(role)
  const focus = (kind: FocusKind, id: string | null) =>
    `${home}?focus=${id ? focusKey(kind, id) : kind}`
  switch (n.kind) {
    case 'to_accept':
      // the booking itself, in "Bookings to accept" (answerable in the notice too)
      return focus('to_accept', text(p.appointment))
    case 'inquiry': {
      // the doctor named in a website request: where it will come to be accepted
      if (String(p.forDoctor) === 'true') return focus('to_accept', null)
      const id = text(p.appointment)
      return id ? `/app/appointments?focus=${focusKey('inquiry', id)}` : n.link
    }
    case 'call_next': {
      // a colleague asks for the next patient: the call, to send them one
      const id = text(p.call)
      return id ? focus('call', id) : n.link
    }
    case 'task': {
      // a task on a visit opens the visit; one without a visit is in the Tasks panel (0096)
      const id = text(p.task)
      if (n.link?.startsWith('/app/visit')) return n.link
      return id ? focus('task', id) : n.link
    }
    case 'appt_confirmed': {
      // the booking's day on the Appointments page (declined ones already carry the day)
      const day = text(p.when) && kigaliDay(String(p.when))
      return day ? `/app/appointments?day=${day}` : n.link
    }
  }
  if (!n.link) return null
  // "/app" for the manager is the dashboard
  if (n.link === '/app' || n.link.startsWith('/app?')) return home + n.link.slice(4)
  return n.link
}

/** Opens a notice: marks it read and goes to its exact place (when it has one). */
export function useOpenNotice() {
  const navigate = useNavigate()
  const role = useSession((s) => s.user?.role)
  const actions = useNotificationActions()
  const target = (n: Notice) => noticeTarget(n, role)
  const open = (n: Notice) => {
    if (!n.read) actions.markRead.mutate([n.id])
    const to = target(n)
    if (to) void navigate({ href: to })
    return to !== null
  }
  return { target, open }
}
