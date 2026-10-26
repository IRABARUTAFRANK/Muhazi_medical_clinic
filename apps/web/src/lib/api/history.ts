import { useInfiniteQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { apiError } from './errors'

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
  /** The visit or the patient file the entry describes (0065). */
  encounterId?: string | null
  patientId?: string | null
  detail: string | null
  reason: string | null
  /** The record as saved (no secrets, no bookkeeping columns). */
  row?: Record<string, unknown>
  /** Updates: each changed field with its old and new value. */
  changes?: { f: string; from: unknown; to: unknown }[]
  /** Names behind the ids: patient file, treatment, medicine, employee, bed, bill… */
  names?: Partial<
    Record<
      | 'file'
      | 'target'
      | 'service'
      | 'item'
      | 'staff'
      | 'referredBy'
      | 'returnTo'
      | 'performer'
      | 'practitioner'
      | 'bed'
      | 'invoice'
      | 'department',
      string
    >
  >
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
      detail: null,
      reason: null,
      row: { station: 'consultation', ticket_no: 'A-002' },
      changes: [{ f: 'taken_by', from: null, to: 'u-doc' }],
      names: { file: 'MMC-000014', staff: 'Dr. Habimana Eric' },
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
      detail: null,
      reason: null,
      row: {
        method: 'momo',
        amount: 18300,
        reference: 'MP261020.1412.A77341',
        payer_phone: '0788123456',
      },
      names: { file: 'MMC-000009', invoice: 'INV-2026-000031' },
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
      detail: null,
      reason: null,
      row: {
        description: 'General consultation',
        quantity: 1,
        unit_price: 5000,
        discount_pct: 10,
        discount_reason: 'Returning patient',
        office: 'consultation',
      },
      names: { file: 'MMC-000009' },
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
      detail: null,
      reason: null,
      row: { code: 'temp', value_num: 37.8, unit: '°C' },
      names: { file: 'MMC-000014', performer: 'Test Nurse' },
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
      row: { file_number: 'MMC-000014', sex: 'female', phone_1: '0788000111' },
      names: { file: 'MMC-000014' },
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
      id: 2,
      at: at(70),
      action: 'update',
      entity: 'service',
      group: 'admin',
      actor: 'Mugabo Théogène',
      actorRole: 'manager',
      actorStaffId: 'MMC-S-0007',
      patient: null,
      detail: null,
      reason: null,
      row: { name_en: 'Tooth extraction', max_discount_pct: 15, active: true },
      changes: [
        { f: 'max_discount_pct', from: 10, to: 15 },
        { f: 'name_fr', from: null, to: 'Extraction dentaire' },
      ],
      names: { target: 'Tooth extraction' },
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
      detail: null,
      reason: null,
      row: { manage_staff: 'reset_pin', confirmed_with_code: false },
      names: { target: 'Test Nurse (MMC-S-0012)' },
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
      if (error) throw apiError(error)
      const d = data as { total: number; items: HistoryItem[] }
      return { total: Number(d.total), items: d.items ?? [] }
    },
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0)
      return loaded < last.total && last.items.length > 0 ? loaded : undefined
    },
  })
}
