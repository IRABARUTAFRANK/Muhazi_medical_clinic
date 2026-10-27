import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CATEGORY_IDS,
  PRACTITIONERS,
  type CategoryId,
  type Practitioner,
  type WeeklyHours,
} from '@mmc/shared'
import { supabase } from '@/lib/supabase'
import { apiError } from './errors'

/**
 * Doctors' own calendars: weekly hours, slot length, days off, a note, and who may see them
 * (only the doctor, the staff, or the staff and the public). Live: `staff_doctor_calendars`,
 * `my_calendar`, `calendar_people`, `save_calendar`. Sample: the sample practitioners.
 */

export const VISIBILITIES = ['private', 'staff', 'public'] as const
export type Visibility = (typeof VISIBILITIES)[number]

export interface DoctorCalendar {
  id: string | null
  userId: string | null
  code: string
  name: string
  title: string
  department: string | null
  categories: CategoryId[]
  languages: string
  hours: WeeklyHours
  slotMinutes: number
  daysOff: string[]
  note: string
  visibility: Visibility
  mine: boolean
  workingNow: boolean
  /** my_calendar only: a calendar is saved; the person may keep one. */
  saved?: boolean
  canKeep?: boolean
}

export interface CalendarPerson {
  userId: string
  name: string
  role: string
  staffId: string | null
  visibility: Visibility | null
  saved: boolean
}

export interface CalendarInput {
  userId: string | null
  hours: WeeklyHours
  slotMinutes: number
  visibility: Visibility
  daysOff: string[]
  note: string
  title: string
  categories: CategoryId[]
  languages: string
}

interface CalendarJson {
  id: string | null
  userId: string | null
  code?: string | null
  name: string | null
  title: string | null
  department?: string | null
  categories: string[] | null
  languages: string | null
  hours: WeeklyHours | null
  slotMinutes: number | null
  daysOff: string[] | null
  note: string | null
  visibility: Visibility | null
  mine: boolean
  workingNow?: boolean
  saved?: boolean
  canKeep?: boolean
}

const isCategory = (v: string): v is CategoryId => (CATEGORY_IDS as readonly string[]).includes(v)

const fromJson = (j: CalendarJson): DoctorCalendar => ({
  id: j.id,
  userId: j.userId,
  code: j.code ?? j.id ?? j.userId ?? '',
  name: j.name ?? '',
  title: j.title ?? '',
  department: j.department ?? null,
  categories: (j.categories ?? []).filter(isCategory),
  languages: j.languages ?? '',
  hours: j.hours ?? {},
  slotMinutes: j.slotMinutes ?? 30,
  daysOff: j.daysOff ?? [],
  note: j.note ?? '',
  visibility: j.visibility ?? 'staff',
  mine: j.mine,
  workingNow: j.workingNow ?? false,
  saved: j.saved,
  canKeep: j.canKeep,
})

/** The calendar as a practitioner, so the booking helpers (free slots, days off) apply. */
export const asPractitioner = (c: DoctorCalendar): Practitioner => ({
  id: c.id ?? c.code,
  code: c.code,
  name: c.name,
  title: c.title,
  cats: c.categories,
  langs: c.languages,
  hours: c.hours,
  slotMinutes: c.slotMinutes,
  seed: 0,
  daysOff: c.daysOff,
  note: c.note,
})

// ---------------------------------------------------------------- sample mode
const sampleCalendars: DoctorCalendar[] = PRACTITIONERS.map((p, i) => ({
  id: p.id,
  userId: null,
  code: p.code,
  name: p.name,
  title: p.title,
  department: null,
  categories: [...p.cats],
  languages: p.langs,
  hours: p.hours,
  slotMinutes: p.slotMinutes,
  daysOff: [],
  note: '',
  visibility: i % 3 === 2 ? 'staff' : 'public',
  mine: false,
  workingNow: false,
}))
let sampleMine: DoctorCalendar = {
  id: null,
  userId: null,
  code: 'me',
  name: '',
  title: '',
  department: null,
  categories: ['consultation'],
  languages: 'KIN · EN',
  hours: {},
  slotMinutes: 30,
  daysOff: [],
  note: '',
  visibility: 'staff',
  mine: true,
  workingNow: false,
  saved: false,
  canKeep: true,
}

// ---------------------------------------------------------------- queries
const KEY = ['calendars'] as const

/** Calendars the staff may see (shared with the staff or the public, and one's own). */
export function useStaffCalendars() {
  return useQuery({
    queryKey: [...KEY, 'staff'],
    queryFn: async (): Promise<DoctorCalendar[]> => {
      if (!supabase) return [...sampleCalendars, ...(sampleMine.saved ? [sampleMine] : [])]
      const { data, error } = await supabase.rpc('staff_doctor_calendars')
      if (error) throw apiError(error)
      return ((data ?? []) as CalendarJson[]).map(fromJson)
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  })
}

/** One person's calendar (default: mine), with a skeleton when none is saved yet. */
export function useMyCalendar(userId: string | null) {
  return useQuery({
    queryKey: [...KEY, 'one', userId ?? 'me'],
    queryFn: async (): Promise<DoctorCalendar> => {
      if (!supabase) return { ...sampleMine }
      const { data, error } = await supabase.rpc('my_calendar', { p_user: userId })
      if (error) throw apiError(error)
      return fromJson(data as CalendarJson)
    },
  })
}

/** Manager: everyone who may keep a calendar (doctors, sonographers, nurses, the manager). */
export function useCalendarPeople(enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, 'people'],
    enabled,
    queryFn: async (): Promise<CalendarPerson[]> => {
      if (!supabase) return []
      const { data, error } = await supabase.rpc('calendar_people')
      if (error) throw apiError(error)
      return (data ?? []) as CalendarPerson[]
    },
  })
}

export function useSaveCalendar() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: CalendarInput) => {
      if (!supabase) {
        sampleMine = {
          ...sampleMine,
          ...input,
          saved: true,
          id: 'me',
        }
        return
      }
      const { error } = await supabase.rpc('save_calendar', {
        p_user: input.userId,
        p_hours: input.hours,
        p_slot_minutes: input.slotMinutes,
        p_visibility: input.visibility,
        p_days_off: input.daysOff,
        p_note: input.note,
        p_title: input.title,
        p_categories: input.categories,
        p_languages: input.languages,
      })
      if (error) throw apiError(error)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY })
      void qc.invalidateQueries({ queryKey: ['public', 'practitioners'] })
    },
  })
}
