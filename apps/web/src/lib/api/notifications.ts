import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'
import { apiError } from './errors'

/**
 * Notifications (migration 0026). Each person sees only what is addressed to them: their own
 * name, their role, their department (heads only when so marked) or everyone. Automatic ones
 * (queue, task, inquiry, to_accept) carry params and are worded in the reader's language;
 * messages from the manager or a head carry their own title and text.
 */
export interface Notice {
  id: string
  at: string
  kind: 'queue' | 'task' | 'inquiry' | 'to_accept' | 'message' | string
  params: Record<string, string | null>
  title: string | null
  body: string | null
  link: string | null
  urgent: boolean
  read: boolean
  sender: string | null
}

const KEY = ['notifications'] as const
let sample: Notice[] = [
  {
    id: 'n0',
    at: new Date(Date.now() - 6 * 60_000).toISOString(),
    kind: 'handover',
    params: {
      by: 'Dr. Uwase Aline',
      ticket: 'A-015',
      name: 'Ingabire Diane',
      station: 'consultation',
      note: 'Called to theatre. Malaria test done (negative); please review the urine test and decide on treatment.',
    },
    title: null,
    body: null,
    link: '/app/visit?encounter=e-consultation-3',
    urgent: true,
    read: false,
    sender: 'Dr. Uwase Aline',
  },
  {
    // the sample doctor's booking to accept (home.ts sample 'ta-1'): answered in the notice
    id: 'n-acc',
    at: new Date(Date.now() - 5 * 60_000).toISOString(),
    kind: 'to_accept',
    params: { name: 'Hakizimana Emmanuel', when: null, appointment: 'ta-1' },
    title: null,
    body: null,
    link: '/app',
    urgent: false,
    read: false,
    sender: null,
  },
  {
    id: 'n1',
    at: new Date(Date.now() - 4 * 60_000).toISOString(),
    kind: 'queue',
    params: { ticket: 'A-019', name: 'Uwase Claudine', station: 'triage', triage: null },
    title: null,
    body: null,
    link: '/app/vitals',
    urgent: false,
    read: false,
    sender: null,
  },
  {
    id: 'n2',
    at: new Date(Date.now() - 25 * 60_000).toISOString(),
    kind: 'message',
    params: {},
    title: 'Staff meeting at 16:00',
    body: 'All heads of department, bring this week’s report.',
    link: null,
    urgent: false,
    read: false,
    sender: 'Mugabo Théogène',
  },
  {
    id: 'n3',
    at: new Date(Date.now() - 70 * 60_000).toISOString(),
    kind: 'task',
    params: { title: 'Injection: ceftriaxone 1 g IM', name: 'Mugisha Kevin', due: null },
    title: null,
    body: null,
    link: '/app/visit?encounter=e-1',
    urgent: false,
    read: true,
    sender: 'Dr. Mukamana Béatrice',
  },
]

export function useNotifications(limit = 40) {
  return useQuery({
    queryKey: [...KEY, limit],
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<{ unread: number; items: Notice[] }> => {
      if (!supabase) {
        // the sample handover and booking notices are for the sample doctor only
        const items = sample.filter(
          (n) =>
            !(n.kind.startsWith('handover') || n.kind === 'to_accept') ||
            useSession.getState().user?.role === 'doctor',
        )
        return { unread: items.filter((n) => !n.read).length, items }
      }
      const { data, error } = await supabase.rpc('my_notifications', { p_limit: limit })
      if (error) throw apiError(error)
      const d = data as { unread: number; items: Notice[] }
      return { unread: Number(d.unread), items: d.items ?? [] }
    },
  })
}

export function useNotificationActions() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: KEY })
  const markRead = useMutation({
    mutationFn: async (ids: string[] | null) => {
      if (!supabase) {
        sample = sample.map((n) => (ids === null || ids.includes(n.id) ? { ...n, read: true } : n))
        return
      }
      const { error } = await supabase.rpc('mark_notifications_read', { p_ids: ids })
      if (error) throw apiError(error)
    },
    onSuccess: refresh,
  })
  const send = useMutation({
    mutationFn: async (i: {
      to: 'all' | 'role' | 'department' | 'user'
      target: string | null
      title: string
      body: string
      headsOnly?: boolean
      urgent?: boolean
    }) => {
      if (!supabase) {
        sample = [
          {
            id: `n-${Date.now()}`,
            at: new Date().toISOString(),
            kind: 'message',
            params: {},
            title: i.title,
            body: i.body,
            link: null,
            urgent: !!i.urgent,
            read: true,
            sender: null,
          },
          ...sample,
        ]
        return
      }
      const { error } = await supabase.rpc('send_notification', {
        p_to: i.to,
        p_target: i.target,
        p_title: i.title,
        p_body: i.body,
        p_heads_only: !!i.headsOnly,
        p_urgent: !!i.urgent,
      })
      if (error) throw apiError(error)
    },
    onSuccess: refresh,
  })
  /** Removes notices from this person's list only (others still see them). */
  const hide = useMutation({
    mutationFn: async (ids: string[]) => {
      if (!supabase) {
        sample = sample.filter((n) => !ids.includes(n.id))
        return
      }
      const { error } = await supabase.rpc('hide_notifications', { p_ids: ids })
      if (error) throw apiError(error)
    },
    onSuccess: refresh,
  })
  /** The sender (or the manager) deletes a message for everyone. */
  const remove = useMutation({
    mutationFn: async (id: string) => {
      if (!supabase) {
        sampleSent = sampleSent.filter((n) => n.id !== id)
        return
      }
      const { error } = await supabase.rpc('delete_notification', { p_id: id })
      if (error) throw apiError(error)
    },
    onSuccess: () => {
      void refresh()
      void qc.invalidateQueries({ queryKey: SENT_KEY })
    },
  })
  return { markRead, send, hide, remove }
}

/** A message this person sent, with how many have read it. */
export interface SentNotice {
  id: string
  at: string
  title: string | null
  body: string | null
  urgent: boolean
  to: 'all' | 'role' | 'department' | 'user'
  target: string | null
  headsOnly: boolean
  readBy: number
}
const SENT_KEY = ['notifications-sent'] as const
let sampleSent: SentNotice[] = [
  {
    id: 'n2',
    at: new Date(Date.now() - 25 * 60_000).toISOString(),
    title: 'Staff meeting at 16:00',
    body: 'All heads of department, bring this week’s report.',
    urgent: false,
    to: 'all',
    target: null,
    headsOnly: true,
    readBy: 3,
  },
]

export function useSentNotifications(enabled: boolean) {
  return useQuery({
    queryKey: SENT_KEY,
    enabled,
    refetchInterval: 60_000,
    queryFn: async (): Promise<SentNotice[]> => {
      if (!supabase) return sampleSent
      const { data, error } = await supabase.rpc('my_sent_notifications', { p_limit: 100 })
      if (error) throw apiError(error)
      return (data as SentNotice[]) ?? []
    },
  })
}
