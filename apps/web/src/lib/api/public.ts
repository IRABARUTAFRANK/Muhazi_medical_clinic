import { useQuery } from '@tanstack/react-query'
import {
  CATEGORY_IDS,
  CLINIC,
  CLINIC_HOURS,
  CLINIC_PROFILE,
  INSURERS,
  PRACTITIONERS,
  SERVICES,
  SERVICE_ICONS,
  addDays,
  isoDate,
  openStatus,
  slotKey,
  type CategoryId,
  type ClinicHours,
  type ClinicProfile,
  type Practitioner,
  type ServiceLine,
  type WeeklyHours,
} from '@mmc/shared'
import { appNow } from '@/lib/clock'
import { supabase } from '@/lib/supabase'

/**
 * Public (anonymous) reads for the landing and booking pages. Each query uses Supabase when it
 * is configured and reachable, and the shared sample data otherwise, so the site always renders.
 */

const STALE = 60_000

async function withFallback<T>(live: () => Promise<T>, sample: () => T): Promise<T> {
  if (!supabase) return sample()
  try {
    return await live()
  } catch (e) {
    console.warn('[mmc] live data unavailable, showing sample data:', e)
    return sample()
  }
}

const isCategory = (v: string): v is CategoryId => (CATEGORY_IDS as readonly string[]).includes(v)

// ---------------------------------------------------------------- practitioners
interface PractitionerRow {
  id: string
  code: string | null
  names: string
  title: string | null
  categories: string[] | null
  languages: string | null
  working_hours: WeeklyHours | null
  slot_minutes: number | null
}

const toPractitioner = (r: PractitionerRow): Practitioner => ({
  id: r.id,
  code: r.code ?? r.id,
  name: r.names,
  title: r.title ?? '',
  cats: (r.categories ?? []).filter(isCategory),
  langs: r.languages ?? '',
  hours: r.working_hours ?? {},
  slotMinutes: r.slot_minutes ?? 60,
  seed: 0,
})

export function usePractitioners() {
  return useQuery({
    queryKey: ['public', 'practitioners'],
    queryFn: () =>
      withFallback(
        async () => {
          const { data, error } = await supabase!
            .from('public_practitioners')
            .select('id, code, names, title, categories, languages, working_hours, slot_minutes')
            .order('names')
          if (error) throw error
          return (data as PractitionerRow[]).map(toPractitioner)
        },
        () => [...PRACTITIONERS],
      ),
    staleTime: STALE,
    placeholderData: [...PRACTITIONERS],
  })
}

// ---------------------------------------------------------------- booked slots (live calendar)
export interface BookedSlots {
  /** false = sample mode: callers fall back to the deterministic sample pattern. */
  live: boolean
  byPractitioner: Map<string, Set<string>>
}
const EMPTY: ReadonlySet<string> = new Set()

/** Busy slots of every practitioner from `from` for `days` days (no names, no reasons). */
export function useBookedSlots(from: Date, days: number) {
  const to = addDays(from, days)
  return useQuery({
    queryKey: ['public', 'booked', isoDate(from), days],
    queryFn: () =>
      withFallback<BookedSlots>(
        async () => {
          const { data, error } = await supabase!
            .from('public_booked_slots')
            .select('practitioner_id, starts_at')
            .gte('starts_at', from.toISOString())
            .lt('starts_at', to.toISOString())
          if (error) throw error
          const byPractitioner = new Map<string, Set<string>>()
          for (const r of data as { practitioner_id: string; starts_at: string }[]) {
            const d = new Date(r.starts_at)
            let set = byPractitioner.get(r.practitioner_id)
            if (!set) {
              set = new Set()
              byPractitioner.set(r.practitioner_id, set)
            }
            set.add(slotKey(d, d.getHours()))
          }
          return { live: true, byPractitioner }
        },
        () => ({ live: false, byPractitioner: new Map() }),
      ),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}

/** Booked set for one practitioner, or undefined in sample mode (→ sample pattern). */
export const bookedFor = (
  slots: BookedSlots | undefined,
  p: Practitioner,
): ReadonlySet<string> | undefined =>
  slots?.live ? (slots.byPractitioner.get(p.id) ?? EMPTY) : undefined

// ---------------------------------------------------------------- service lines, insurers
export function useServiceLines() {
  return useQuery({
    queryKey: ['public', 'service-lines'],
    queryFn: () =>
      withFallback(
        async () => {
          const { data, error } = await supabase!
            .from('public_service_lines')
            .select('category, price_from, has_free')
          if (error) throw error
          const rows = data as {
            category: string
            price_from: number | string | null
            has_free: boolean
          }[]
          const byCat = new Map(rows.map((r) => [r.category, r]))
          return CATEGORY_IDS.map<ServiceLine>((id) => {
            const r = byCat.get(id)
            return {
              id,
              priceFrom: r?.price_from != null ? Number(r.price_from) : null,
              hasFree: r?.has_free ?? false,
              icon: SERVICE_ICONS[id],
            }
          })
        },
        () => [...SERVICES],
      ),
    staleTime: STALE,
    placeholderData: [...SERVICES],
  })
}

export function usePayers() {
  return useQuery({
    queryKey: ['public', 'payers'],
    queryFn: () =>
      withFallback(
        async () => {
          const { data, error } = await supabase!.from('public_payers').select('name')
          if (error) throw error
          return (data as { name: string }[]).map((r) => r.name)
        },
        () => [...INSURERS],
      ),
    staleTime: STALE,
    placeholderData: [...INSURERS],
  })
}

// ---------------------------------------------------------------- clinic info and live status
export interface ClinicInfo {
  profile: ClinicProfile
  hours: ClinicHours
}
const SAMPLE_INFO: ClinicInfo = { profile: CLINIC_PROFILE, hours: CLINIC_HOURS }

export function useClinicInfo() {
  return useQuery({
    queryKey: ['public', 'clinic-info'],
    queryFn: () =>
      withFallback(
        async () => {
          const { data, error } = await supabase!.rpc('public_clinic_info')
          if (error) throw error
          const d = (data ?? {}) as { profile?: Partial<ClinicProfile>; hours?: ClinicHours }
          return {
            profile: { ...CLINIC_PROFILE, ...(d.profile ?? {}) },
            hours: d.hours?.days ? d.hours : CLINIC_HOURS,
          }
        },
        () => SAMPLE_INFO,
      ),
    staleTime: 5 * 60_000,
    placeholderData: SAMPLE_INFO,
  })
}

export interface ClinicStatus {
  open: boolean
  closesAt?: string
  opensAt?: string
  waiting: number
  avgWaitMin: number
  live: boolean
}

const sampleStatus = (hours: ClinicHours): ClinicStatus => ({
  ...openStatus(hours, appNow()),
  waiting: CLINIC.currentWaiting,
  avgWaitMin: CLINIC.currentWaitMin,
  live: false,
})

/** "Clinic now": open/closed from the hours setting, waiting count and average wait from the queue. */
export function useClinicStatus(hours: ClinicHours) {
  return useQuery({
    queryKey: ['public', 'status'],
    queryFn: () =>
      withFallback(
        async () => {
          const { data, error } = await supabase!.rpc('public_clinic_status')
          if (error) throw error
          const d = data as {
            open: boolean
            closes_at: string | null
            opens_at: string | null
            waiting: number
            avg_wait_min: number | string
          }
          return {
            open: d.open,
            closesAt: d.closes_at ?? undefined,
            opensAt: d.opens_at ?? undefined,
            waiting: Number(d.waiting),
            avgWaitMin: Number(d.avg_wait_min),
            live: true,
          }
        },
        () => sampleStatus(hours),
      ),
    refetchInterval: 60_000,
    placeholderData: sampleStatus(hours),
  })
}
