import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

/**
 * A nurse covering for a doctor (migration 0035): during the cover the nurse has the doctor's
 * rights, receives the patients sent to that doctor and sees the doctor's queue.
 */
export interface CoverCovering {
  id: string
  doctorId: string
  doctor: string
  station: string | null
  until: string
  note: string | null
}
export interface CoverBy {
  id: string
  nurseId: string
  nurse: string
  until: string
  note: string | null
}
export interface MyCover {
  covering: CoverCovering[]
  coveredBy: CoverBy[]
}

let sample: MyCover = { covering: [], coveredBy: [] }
const KEY = ['cover'] as const

export function useMyCover() {
  return useQuery({
    queryKey: KEY,
    refetchInterval: 60_000,
    queryFn: async (): Promise<MyCover> => {
      if (!supabase) return sample
      const { data, error } = await supabase.rpc('my_cover')
      if (error) throw new Error(error.message)
      return (data as MyCover) ?? { covering: [], coveredBy: [] }
    },
  })
}

export function useCoverActions() {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: KEY })
    void qc.invalidateQueries({ queryKey: ['queue'] })
  }
  const start = useMutation({
    mutationFn: async (i: { nurseId: string; nurse: string; until: string; note: string }) => {
      if (!supabase) {
        sample = {
          ...sample,
          coveredBy: [
            {
              id: `c-${Date.now()}`,
              nurseId: i.nurseId,
              nurse: i.nurse,
              until: i.until,
              note: i.note || null,
            },
          ],
        }
        return
      }
      const { error } = await supabase.rpc('start_cover', {
        p_nurse: i.nurseId,
        p_until: i.until,
        p_note: i.note.trim() || null,
      })
      if (error) throw new Error(error.message)
    },
    onSuccess: refresh,
  })
  const end = useMutation({
    mutationFn: async (id: string) => {
      if (!supabase) {
        sample = {
          covering: sample.covering.filter((c) => c.id !== id),
          coveredBy: sample.coveredBy.filter((c) => c.id !== id),
        }
        return
      }
      const { error } = await supabase.rpc('end_cover', { p_id: id })
      if (error) throw new Error(error.message)
    },
    onSuccess: refresh,
  })
  return { start, end }
}
