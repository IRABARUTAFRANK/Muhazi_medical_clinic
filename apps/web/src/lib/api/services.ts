import { useQuery } from '@tanstack/react-query'
import { CATEGORY_IDS, PRACTITIONERS, type CategoryId } from '@mmc/shared'
import { supabase } from '@/lib/supabase'
import type { Station } from './visits'

/**
 * The clinic's services, as on the website: medical consultation, dental services, laboratory
 * services, nursing care, minor surgery, ultrasound, circumcision, family planning, HIV testing &
 * vaccination; plus the pharmacy (to buy medicines). Choosing one chooses its section (desk).
 */
export type ServiceId = CategoryId | 'pharmacy'
export const SERVICES: readonly ServiceId[] = [...CATEGORY_IDS, 'pharmacy']

/** The desk of each service (the database's service_station agrees). */
export const SERVICE_DESK: Record<ServiceId, Station> = {
  consultation: 'consultation',
  dental: 'dental',
  laboratory: 'laboratory',
  ultrasound: 'ultrasound',
  nursing: 'nursing',
  surgery: 'theatre',
  circ: 'theatre',
  fp: 'nursing',
  hiv: 'nursing',
  pharmacy: 'pharmacy',
}

/** One person who gives a service, and what they do now. */
export interface ServicePerson {
  id: string
  name: string
  role: string
  station: string | null
  departments: string | null
  specialty: string | null
  /** By their calendar's hours; null when they keep no calendar. */
  workingNow: boolean | null
  /** Signed in today. */
  onDuty: boolean
  /** Patients sent to them, not taken yet. */
  waiting: number
  /** Patients they are with now. */
  seeing: number
}
export interface ServiceStaff {
  service: ServiceId
  station: Station
  /** Patients waiting at the section for anyone. */
  sectionWaiting: number
  staff: ServicePerson[]
}

/** Sample mode: the sample doctors who list the service, as if on duty. */
const sampleStaff = (service: ServiceId): ServiceStaff => ({
  service,
  station: SERVICE_DESK[service],
  sectionWaiting: 2,
  staff: PRACTITIONERS.filter((p) => service !== 'pharmacy' && p.cats.includes(service)).map(
    (p, i) => ({
      id: `u-${p.code}`,
      name: p.name,
      role: 'doctor',
      station: null,
      departments: null,
      specialty: p.title,
      workingNow: i % 2 === 0,
      onDuty: true,
      waiting: i,
      seeing: i % 2,
    }),
  ),
})

/** Who gives this service now (send the patient to the section or to one of them). */
export function useServiceStaff(service: ServiceId | null) {
  return useQuery({
    queryKey: ['service-staff', service],
    enabled: !!service,
    refetchInterval: 30_000,
    queryFn: async (): Promise<ServiceStaff> => {
      if (!supabase) return sampleStaff(service!)
      const { data, error } = await supabase.rpc('service_staff', { p_service: service })
      if (error) throw new Error(error.message)
      const d = data as ServiceStaff
      return {
        ...d,
        sectionWaiting: Number(d.sectionWaiting),
        staff: (d.staff ?? []).map((p) => ({
          ...p,
          waiting: Number(p.waiting),
          seeing: Number(p.seeing),
        })),
      }
    },
  })
}
