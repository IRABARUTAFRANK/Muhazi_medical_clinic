import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ROLE_HOME, type Lang } from '@mmc/shared'
import { supabase } from '@/lib/supabase'
import type { Station } from '@/lib/api/visits'
import { apiError } from './errors'

/** The languages the browser's voice can say (0118): no Kinyarwanda voice exists. */
export type VoiceLang = 'en' | 'fr'
export const VOICE_LANGS: readonly VoiceLang[] = ['en', 'fr']
export const VOICE_REPEATS = [1, 2, 3] as const

/**
 * The waiting-room screen (migration 0114). A TV at the waiting side opens /display?key=… and
 * reads `display_board(key)` as a visitor: per desk who was just called (and where to go), who
 * is next, and whose results are ready. The manager registers screens in Settings (the key is
 * shown once). Staff call a patient to the screen with `call_patient`; after Finish / send-on
 * `next_for_me` offers the patient to take next. Sample mode (no database): a sample board that
 * calls a new patient every 20 seconds, so the ding and the flash can be seen.
 */

// ---------------------------------------------------------------- the board
export interface BoardNow {
  id: string
  ticket: string
  /** Null when the screen does not show names. */
  name: string | null
  /** The room of the person who called or took the patient ("Consultation 1"). */
  room: string | null
  person: string | null
  calledAt: string
  /** Already with the clinician (taken), not only called. */
  started: boolean
}
export interface BoardNext {
  id: string
  ticket: string
  name: string | null
  /** 1 red, 2 yellow, 3 green. */
  priority: 1 | 2 | 3
  /** 0119: the doctor the patient was sent to by name, and that doctor's room (else null). */
  person?: string | null
  room?: string | null
}
export interface BoardDesk {
  station: Station
  now: BoardNow[]
  next: BoardNext[]
  waiting: number
}
export interface BoardResult {
  id: string
  ticket: string | null
  name: string | null
  at: string
}
export interface DisplayBoard {
  name: string
  clinic: string
  desks: BoardDesk[]
  results: BoardResult[]
  message: string | null
  chime: boolean
  languages: Lang[]
  showNames: boolean
  /** 0118: the call is said aloud by the browser's voice, in English or French, 1 to 3 times. */
  voice: boolean
  voiceLang: VoiceLang
  voiceRepeat: number
  /** 0118: the scrolling line at the bottom. */
  ticker: boolean
  /** Changes whenever the board does (a quick "something new?" check). */
  version: number
  /** The time at the clinic when the board was read. */
  now: string
}

/** Sample board: three desks; consultation calls a new patient every 20 seconds. */
const SAMPLE_ROOMS = ['Consultation 1', 'Consultation 2']
function sampleBoard(): DisplayBoard {
  const tick = Math.floor(Date.now() / 20_000)
  const rows = ROLE_HOME.doctor.queue
  const calledIndex = tick % rows.length
  const called = rows[calledIndex]!
  const earlier = rows[(calledIndex + rows.length - 1) % rows.length]!
  const waiting = rows.filter(
    (_, i) => i !== calledIndex && i !== (calledIndex + rows.length - 1) % rows.length,
  )
  const prio = (triage: string): 1 | 2 | 3 => (triage === 'red' ? 1 : triage === 'yellow' ? 2 : 3)
  // times fixed within the 20-second window, so a poll never looks like a new call
  const at = (secondsAgo: number) => new Date(tick * 20_000 - secondsAgo * 1000).toISOString()
  const consultation: BoardDesk = {
    station: 'consultation',
    now: [
      {
        id: `now-${tick}`,
        ticket: called.ticket,
        name: called.name,
        room: SAMPLE_ROOMS[tick % 2]!,
        person: 'Dr. Mukamana Béatrice',
        calledAt: at(0),
        started: false,
      },
      {
        id: `now-${tick - 1}`,
        ticket: earlier.ticket,
        name: earlier.name,
        room: SAMPLE_ROOMS[(tick + 1) % 2]!,
        person: 'Dr. Habineza Jean',
        calledAt: at(20),
        started: true,
      },
    ],
    next: waiting.map((q, i) => ({
      id: `next-${i}`,
      ticket: q.ticket,
      name: q.name,
      priority: prio(q.triage),
      // the first one was sent to a doctor by name (0119)
      person: i === 0 ? 'Dr. Habineza Jean' : null,
      room: i === 0 ? 'Consultation 2' : null,
    })),
    waiting: waiting.length + 2,
  }
  // other patients than the doctor's, so the sample never calls one person at two desks
  const laboratory: BoardDesk = {
    station: 'laboratory',
    now: [
      {
        id: 'lab-now',
        ticket: 'A-011',
        name: 'Mutesi Aline',
        room: 'Laboratory',
        person: 'Uwera Diane',
        // a fixed time (the hour), so this entry is never taken for a new call
        calledAt: new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString(),
        started: true,
      },
    ],
    next: [
      { id: 'lab-next-0', ticket: 'A-013', name: 'Niyonsaba Eric', priority: 2 },
      { id: 'lab-next-1', ticket: 'A-017', name: 'Mukeshimana Rose', priority: 3 },
      { id: 'lab-next-2', ticket: 'A-018', name: 'Bizimana Jean de Dieu', priority: 3 },
    ],
    waiting: 3,
  }
  const pharmacy: BoardDesk = {
    station: 'pharmacy',
    now: [],
    next: [
      { id: 'ph-1', ticket: 'A-007', name: 'Kamanzi Olivier', priority: 3 },
      { id: 'ph-2', ticket: 'A-010', name: 'Uwimana Grace', priority: 3 },
    ],
    waiting: 2,
  }
  return {
    name: 'Waiting room',
    clinic: 'Muhazi Medical Clinic',
    desks: [consultation, laboratory, pharmacy],
    results: [
      // a new result every minute, so the announcement of a result can be heard
      ...(tick % 3 === 2
        ? [{ id: `r-${Math.floor(tick / 3)}`, ticket: 'A-003', name: 'Uwase Claudine', at: at(0) }]
        : []),
      { id: 'r-1', ticket: 'A-005', name: 'Ingabire Diane', at: at(300) },
      { id: 'r-2', ticket: 'A-008', name: 'Mugisha Yves', at: at(900) },
    ],
    message: 'Please keep your ticket. Red and yellow tickets are seen first.',
    chime: true,
    languages: ['rw', 'en', 'fr'],
    showNames: true,
    voice: true,
    voiceLang: 'en',
    voiceRepeat: 2,
    ticker: true,
    version: tick,
    now: new Date().toISOString(),
  }
}

/** Reads the board every 3 seconds; the key comes from the address of the TV's page. */
export function useDisplayBoard(key: string) {
  return useQuery({
    queryKey: ['display', 'board', key],
    enabled: key !== '',
    refetchInterval: 3_000,
    refetchIntervalInBackground: true,
    retry: (count, e) =>
      !(e instanceof Error && 'hint' in e && e.hint === 'screen_unknown') && count < 3,
    queryFn: async (): Promise<DisplayBoard> => {
      // sample mode: any key shows the sample board; the key "empty" a clinic with nobody waiting
      if (!supabase) {
        const b = sampleBoard()
        return key === 'empty'
          ? {
              ...b,
              desks: b.desks.map((d) => ({ ...d, now: [], next: [], waiting: 0 })),
              results: [],
            }
          : b
      }
      const { data, error } = await supabase.rpc('display_board', { p_key: key })
      if (error) throw apiError(error)
      return data as DisplayBoard
    },
  })
}

// ---------------------------------------------------------------- the screens (manager)
export interface DisplayScreen {
  id: string
  name: string
  /** Stations shown; none = every desk with patients. */
  desks: Station[]
  showNames: boolean
  chime: boolean
  languages: Lang[]
  message: string | null
  voice: boolean
  voiceLang: VoiceLang
  voiceRepeat: number
  ticker: boolean
  active: boolean
  createdAt: string
  createdBy: string | null
  revokedAt: string | null
}
export interface DisplayScreenInput {
  id?: string
  name: string
  desks: Station[]
  showNames: boolean
  chime: boolean
  languages: Lang[]
  message: string
  voice: boolean
  voiceLang: VoiceLang
  voiceRepeat: number
  ticker: boolean
}

const SCREENS_KEY = ['display', 'screens'] as const
const sampleScreens: DisplayScreen[] = [
  {
    id: 'scr-1',
    name: 'Waiting room TV',
    desks: ['consultation', 'laboratory', 'pharmacy'],
    showNames: true,
    chime: true,
    languages: ['rw', 'en', 'fr'],
    message: 'Please keep your ticket.',
    voice: true,
    voiceLang: 'en',
    voiceRepeat: 2,
    ticker: true,
    active: true,
    createdAt: new Date(Date.now() - 6 * 86_400_000).toISOString(),
    createdBy: 'Mugabo Théogène',
    revokedAt: null,
  },
]

export function useDisplayScreens() {
  return useQuery({
    queryKey: SCREENS_KEY,
    queryFn: async (): Promise<DisplayScreen[]> => {
      if (!supabase) return sampleScreens.map((s) => ({ ...s }))
      const { data, error } = await supabase.rpc('display_screens')
      if (error) throw apiError(error)
      return (data as DisplayScreen[]) ?? []
    },
  })
}

/** The address the TV opens: this site, /display, with the key. */
export const displayLink = (key: string): string =>
  `${window.location.origin}/display?key=${encodeURIComponent(key)}`

export function useDisplayScreenActions() {
  const qc = useQueryClient()
  const refresh = () => void qc.invalidateQueries({ queryKey: SCREENS_KEY })
  /** Creates (the answer carries the key, shown once) or changes a screen. */
  const save = useMutation({
    mutationFn: async (i: DisplayScreenInput): Promise<{ id: string; key?: string }> => {
      if (!supabase) {
        if (i.id) {
          const s = sampleScreens.find((x) => x.id === i.id)
          if (s) Object.assign(s, { ...i, message: i.message.trim() || null })
          return { id: i.id }
        }
        const id = `scr-${sampleScreens.length + 1}`
        sampleScreens.unshift({
          id,
          name: i.name,
          desks: i.desks,
          showNames: i.showNames,
          chime: i.chime,
          languages: i.languages,
          message: i.message.trim() || null,
          voice: i.voice,
          voiceLang: i.voiceLang,
          voiceRepeat: i.voiceRepeat,
          ticker: i.ticker,
          active: true,
          createdAt: new Date().toISOString(),
          createdBy: 'Mugabo Théogène',
          revokedAt: null,
        })
        return { id, key: 'sample'.padEnd(64, '0') }
      }
      // all eleven arguments: the 0118 function (the seven-argument one of 0114 stays for older callers)
      const { data, error } = await supabase.rpc('save_display_screen', {
        p_id: i.id ?? null,
        p_name: i.name,
        p_desks: i.desks,
        p_show_names: i.showNames,
        p_chime: i.chime,
        p_languages: i.languages,
        p_message: i.message.trim() || null,
        p_voice: i.voice,
        p_voice_lang: i.voiceLang,
        p_voice_repeat: i.voiceRepeat,
        p_ticker: i.ticker,
      })
      if (error) throw apiError(error)
      return data as { id: string; key?: string }
    },
    onSuccess: refresh,
  })
  const revoke = useMutation({
    mutationFn: async (id: string) => {
      if (!supabase) {
        const s = sampleScreens.find((x) => x.id === id)
        if (s) {
          s.active = false
          s.revokedAt = new Date().toISOString()
        }
        return
      }
      const { error } = await supabase.rpc('revoke_display_screen', { p_id: id })
      if (error) throw apiError(error)
    },
    onSuccess: refresh,
  })
  return { save, revoke }
}

// ---------------------------------------------------------------- calling, and the next patient
/** Sample mode: when each sample queue row was last called (for "Call again"). */
const sampleCalled = new Map<string, string>()
export const sampleCalledAt = (queueId: string): string | null => sampleCalled.get(queueId) ?? null

/**
 * "Come to …" on the waiting-room screen: by queue entry (the queues), or by visit and desk
 * (the laboratory worklist, which lists tests, not queue entries). Callable again.
 */
export function useCallPatient() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (
      target: { queueId: string } | { encounterId: string; station: Station },
    ): Promise<{ ticket: string; calledAt: string }> => {
      if (!supabase) {
        const now = new Date().toISOString()
        if ('queueId' in target) sampleCalled.set(target.queueId, now)
        return { ticket: '', calledAt: now }
      }
      const { data, error } =
        'queueId' in target
          ? await supabase.rpc('call_patient', { p_queue_id: target.queueId })
          : await supabase.rpc('call_patient_at', {
              p_encounter_id: target.encounterId,
              p_station: target.station,
            })
      if (error) throw apiError(error)
      return data as { ticket: string; calledAt: string }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['queue'] })
      void qc.invalidateQueries({ queryKey: ['display', 'next'] })
      void qc.invalidateQueries({ queryKey: ['lab'] })
    },
  })
}

export interface NextForMe {
  queueId: string
  encounterId: string
  ticket: string
  name: string
  priority: 1 | 2 | 3
  triage: 'red' | 'yellow' | 'green' | null
  station: Station
  queuedAt: string
  calledAt: string | null
  /** Sent to me by name (a colleague's referral). */
  assignedToMe: boolean
  department: string | null
  /** How many wait at that desk. */
  waiting: number
}

/** The patient to offer after Finish / send-on (or on My queue): null when nobody waits. */
export function useNextForMe(station: Station | null, enabled = true) {
  return useQuery({
    queryKey: ['display', 'next', station],
    enabled,
    refetchInterval: 10_000,
    queryFn: async (): Promise<NextForMe | null> => {
      if (!supabase) {
        const q = ROLE_HOME.doctor.queue[1]
        if (!q || !station) return null
        return {
          queueId: `q-${station}-1`,
          encounterId: `e-${station}-1`,
          ticket: q.ticket,
          name: q.name,
          priority: q.triage === 'red' ? 1 : q.triage === 'yellow' ? 2 : 3,
          triage: q.triage,
          station,
          queuedAt: new Date(Date.now() - q.waitMin * 60_000).toISOString(),
          calledAt: sampleCalledAt(`q-${station}-1`),
          assignedToMe: false,
          department: null,
          waiting: ROLE_HOME.doctor.queue.length,
        }
      }
      const { data, error } = await supabase.rpc('next_for_me', { p_station: station })
      if (error) throw apiError(error)
      return (data as NextForMe | null) ?? null
    },
  })
}
