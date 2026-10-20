import { useInfiniteQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

/**
 * Activity history (migration 0031): every change to the clinic's records, sign-ins and staff /
 * settings changes, from the audit log, newest first. Managers only; kept for good.
 */
export type HistoryGroup =
  'signin' | 'patients' | 'vitals' | 'queue' | 'billing' | 'clinical' | 'beds' | 'admin' | 'other'
export const HISTORY_GROUPS: HistoryGroup[] = [
  'signin',
  'patients',
  'vitals',
  'queue',
  'clinical',
  'billing',
  'beds',
  'admin',
]

export interface HistoryItem {
  id: number
  at: string
  action: 'create' | 'update' | 'delete' | 'login' | 'settings' | 'break_glass'
  entity: string
  group: HistoryGroup
  actor: string | null
  actorRole: string | null
  actorStaffId: string | null
  patient: string | null
  detail: string | null
  reason: string | null
}
export interface HistoryFilter {
  from: string
  to: string
  actor: string | null
  group: HistoryGroup | null
}

const PAGE = 60

const sample = (): HistoryItem[] => {
  const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
  return [
    {
      id: 9,
      at: at(3),
      action: 'update',
      entity: 'queue_entry',
      group: 'queue',
      actor: 'Dr. Habimana Eric',
      actorRole: 'doctor',
      actorStaffId: 'MMC-S-0013',
      patient: 'Baby Benitah',
      detail: 'A-002 · consultation · taken',
      reason: null,
    },
    {
      id: 8,
      at: at(9),
      action: 'create',
      entity: 'payment',
      group: 'billing',
      actor: 'Mugisha Samuel',
      actorRole: 'cashier',
      actorStaffId: 'MMC-S-0004',
      patient: 'Uwase Claudine',
      detail: 'momo · 18300',
      reason: null,
    },
    {
      id: 7,
      at: at(15),
      action: 'create',
      entity: 'invoice_line',
      group: 'billing',
      actor: 'Dr. Habimana Eric',
      actorRole: 'doctor',
      actorStaffId: 'MMC-S-0013',
      patient: 'Uwase Claudine',
      detail: 'Consultation · 5000',
      reason: null,
    },
    {
      id: 6,
      at: at(22),
      action: 'create',
      entity: 'observation',
      group: 'vitals',
      actor: 'Test Nurse',
      actorRole: 'nurse',
      actorStaffId: 'MMC-S-0012',
      patient: 'Baby Benitah',
      detail: 'temp 37.8',
      reason: null,
    },
    {
      id: 5,
      at: at(30),
      action: 'create',
      entity: 'patient',
      group: 'patients',
      actor: 'Test Nurse',
      actorRole: 'nurse',
      actorStaffId: 'MMC-S-0012',
      patient: 'Baby Benitah',
      detail: null,
      reason: null,
    },
    {
      id: 4,
      at: at(41),
      action: 'login',
      entity: 'profiles',
      group: 'signin',
      actor: 'Test Receptionist',
      actorRole: 'receptionist',
      actorStaffId: 'MMC-S-0011',
      patient: null,
      detail: null,
      reason: 'code',
    },
    {
      id: 3,
      at: at(55),
      action: 'settings',
      entity: 'profiles',
      group: 'admin',
      actor: 'Mugabo Théogène',
      actorRole: 'manager',
      actorStaffId: 'MMC-S-0007',
      patient: null,
      detail: 'reset_pin',
      reason: null,
    },
  ]
}

export function useActivityHistory(f: HistoryFilter) {
  return useInfiniteQuery({
    queryKey: ['history', f],
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<{ total: number; items: HistoryItem[] }> => {
      if (!supabase) {
        const items = sample().filter(
          (x) => (!f.group || x.group === f.group) && (!f.actor || x.actorStaffId === f.actor),
        )
        return { total: items.length, items: pageParam === 0 ? items : [] }
      }
      const { data, error } = await supabase.rpc('activity_history', {
        p_from: f.from,
        p_to: f.to,
        p_actor: f.actor,
        p_group: f.group,
        p_limit: PAGE,
        p_offset: pageParam,
      })
      if (error) throw new Error(error.message)
      const d = data as { total: number; items: HistoryItem[] }
      return { total: Number(d.total), items: d.items ?? [] }
    },
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0)
      return loaded < last.total && last.items.length > 0 ? loaded : undefined
    },
  })
}
