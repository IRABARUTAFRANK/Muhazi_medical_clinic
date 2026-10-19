import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

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

export function useNotifications() {
  return useQuery({
    queryKey: KEY,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<{ unread: number; items: Notice[] }> => {
      if (!supabase) return { unread: sample.filter((n) => !n.read).length, items: sample }
      const { data, error } = await supabase.rpc('my_notifications', { p_limit: 40 })
      if (error) throw new Error(error.message)
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
      if (error) throw new Error(error.message)
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
      if (error) throw new Error(error.message)
    },
    onSuccess: refresh,
  })
  return { markRead, send }
}
