import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Station } from '@/lib/api/visits'

/**
 * Referrals (migration 0034): hand a patient to another desk or a named colleague with a reason,
 * optionally asking for the patient back afterwards; the receiver sends them back in one action.
 */
export interface Colleague {
  id: string
  name: string
  role: string
  station: string | null
  department: string | null
  staffId: string | null
}

export interface RoutingEntry {
  queueId: string
  station: Station
  since: string
  assignedTo: string | null
  assignedName: string | null
  referredBy: string | null
  referredName: string | null
  note: string | null
  returnStation: Station | null
  returnTo: string | null
  returnName: string | null
  /** Who took the patient at that desk, and whether I may work there (migration 0057). */
  takenBy?: string | null
  takenName?: string | null
  canWork?: boolean
}

const sampleColleagues: Colleague[] = [
  {
    id: 'u-d1',
    name: 'Dr. Habimana Eric',
    role: 'doctor',
    station: 'Consultation 1',
    department: 'General medicine',
    staffId: 'MMC-S-0013',
  },
  {
    id: 'u-d2',
    name: 'Muganga Amenyo',
    role: 'doctor',
    station: 'Dental',
    department: 'Dental',
    staffId: 'MMC-S-0014',
  },
  {
    id: 'u-l1',
    name: 'Uwera Diane',
    role: 'lab_tech',
    station: 'Laboratory',
    department: 'Laboratory',
    staffId: 'MMC-S-0015',
  },
]

export function useColleagues() {
  return useQuery({
    queryKey: ['colleagues'],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Colleague[]> => {
      if (!supabase) return sampleColleagues
      const { data, error } = await supabase.rpc('colleagues')
      if (error) throw new Error(error.message)
      return (data as Colleague[]) ?? []
    },
  })
}

export function useVisitRouting(encounterId: string) {
  return useQuery({
    queryKey: ['routing', encounterId],
    refetchInterval: 20_000,
    queryFn: async (): Promise<RoutingEntry[]> => {
      if (!supabase) return []
      const { data, error } = await supabase.rpc('visit_routing', { p_encounter_id: encounterId })
      if (error) throw new Error(error.message)
      return (data as RoutingEntry[]) ?? []
    },
  })
}

export function useRefer(encounterId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (i: {
      from: Station
      to: Station
      toUser?: string | null
      note?: string
      comeBack?: boolean
      /** Only this department's staff may take the patient (migration 0055). */
      department?: string | null
      /** The service at that desk (Family planning at Nursing): its people take (migration 0071). */
      service?: string | null
    }) => {
      if (!supabase) return
      const args = {
        p_encounter_id: encounterId,
        p_from: i.from,
        p_to: i.to,
        p_to_user: i.toUser ?? null,
        p_note: i.note?.trim() || null,
        p_return: !!i.comeBack,
        // only when chosen, so a database without migration 0055 still takes referrals
        ...(i.department ? { p_department: i.department } : {}),
      }
      let { error } = await supabase.rpc('refer_patient', {
        ...args,
        ...(i.service ? { p_service: i.service } : {}),
      })
      // before migration 0071 the desk is enough
      if (error && i.service && /function|schema cache/i.test(error.message))
        ({ error } = await supabase.rpc('refer_patient', args))
      if (error) throw new Error(error.message)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['routing', encounterId] })
      void qc.invalidateQueries({ queryKey: ['queue'] })
      void qc.invalidateQueries({ queryKey: ['visit'] })
      void qc.invalidateQueries({ queryKey: ['access'] })
    },
  })
}
