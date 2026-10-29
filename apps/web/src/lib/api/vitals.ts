import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import type { Vital } from './billing'
import { apiError, isMissingFunction, sampleRefusal } from './errors'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'

/**
 * Vital signs the clinic chooses (migration 0102).
 *
 * The catalogue below is the list of measurements the form knows, each with its unit and the
 * values a living patient can have (newborn to adult, critically ill included): outside them it
 * is a typing mistake. The database holds the same catalogue (`vital_type`) and checks the same
 * limits. A measurement outside the catalogue is "Other": a typed name and unit, saved under
 * code `custom_<slug>` with its name in `label`.
 *
 * The clinic's default set (which measurements the nurse sees first, in which order) is the
 * setting `vitals.default`, chosen by the manager in Settings › Vital signs. BMI is computed on
 * the screens from weight and height, never stored.
 */

export interface VitalType {
  code: string
  unit: string
  min: number
  max: number
  /** An example value shown in the empty box. */
  placeholder: string
}

export const VITAL_CATALOGUE: readonly VitalType[] = [
  { code: 'bp_sys', unit: 'mmHg', min: 40, max: 300, placeholder: '120' },
  { code: 'bp_dia', unit: 'mmHg', min: 20, max: 200, placeholder: '80' },
  { code: 'pulse', unit: 'bpm', min: 20, max: 250, placeholder: '72' },
  { code: 'temp', unit: '°C', min: 30, max: 44, placeholder: '36.8' },
  { code: 'resp', unit: '/min', min: 4, max: 100, placeholder: '16' },
  { code: 'spo2', unit: '%', min: 40, max: 100, placeholder: '98' },
  { code: 'weight', unit: 'kg', min: 0.3, max: 350, placeholder: '65' },
  { code: 'height', unit: 'cm', min: 20, max: 250, placeholder: '170' },
  { code: 'muac', unit: 'cm', min: 5, max: 60, placeholder: '' },
  { code: 'glucose_mmol', unit: 'mmol/L', min: 0.5, max: 60, placeholder: '5.5' },
  { code: 'glucose_mgdl', unit: 'mg/dL', min: 10, max: 1100, placeholder: '100' },
  { code: 'pain', unit: '/10', min: 0, max: 10, placeholder: '0' },
  { code: 'head_circ', unit: 'cm', min: 20, max: 70, placeholder: '' },
  { code: 'urine_output', unit: 'mL', min: 0, max: 10000, placeholder: '' },
  { code: 'gcs', unit: '/15', min: 3, max: 15, placeholder: '15' },
  { code: 'fundal_height', unit: 'cm', min: 5, max: 60, placeholder: '' },
  { code: 'fhr', unit: 'bpm', min: 60, max: 240, placeholder: '140' },
]
/** The computed body mass index: shown in the form and on the visit, never saved. */
export const BMI_CODE = 'bmi'
/** The clinic's set before the manager chooses one: the nine of before. */
export const DEFAULT_VITALS: readonly string[] = [
  'bp_sys',
  'bp_dia',
  'pulse',
  'temp',
  'resp',
  'spo2',
  'weight',
  'height',
  'muac',
]
/** What the manager can tick: the catalogue and the computed BMI. */
export const SETTABLE_VITALS: readonly string[] = [...VITAL_CATALOGUE.map((v) => v.code), BMI_CODE]

export const vitalType = (code: string): VitalType | undefined =>
  VITAL_CATALOGUE.find((v) => v.code === code)
export const isCustomVital = (code: string) => code.startsWith('custom_')
/** The code of a custom measurement from its typed name: "Blood ketones" → custom_blood_ketones. */
export function customVitalCode(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return `custom_${slug || 'other'}`
}
/** The name of a measurement in the person's language (a custom one: as typed). */
export function vitalName(v: { code: string; label?: string | null }, t: TFunction): string {
  if (v.label) return v.label
  if (v.code === BMI_CODE) return t('vitals.bmi')
  return t(`triage.vitals.${v.code}`, { defaultValue: v.code.replace(/^custom_/, '') })
}
/** The unit of a measurement: the catalogue's, or the one typed for a custom one. */
export const vitalUnit = (v: { code: string; unit?: string | null }): string =>
  v.unit ?? vitalType(v.code)?.unit ?? ''
/** Body mass index from weight (kg) and height (cm), one decimal; null when either is missing. */
export function bmiOf(weightKg: number | null | undefined, heightCm: number | null | undefined) {
  if (!weightKg || !heightCm || weightKg <= 0 || heightCm <= 0) return null
  const m = heightCm / 100
  return Math.round((weightKg / (m * m)) * 10) / 10
}

/** One measurement sent to record_vitals: a custom one carries its unit and typed name. */
export interface VitalEntry {
  value: number
  unit: string | null
  label: string | null
}
/** The vitals as the form sends them: a typed number per catalogue code, an entry per custom one. */
export type VitalsInput = Record<string, string | VitalEntry>

export interface VitalsSetting {
  /** The default set, in order ('bmi' = the computed BMI). */
  codes: string[]
}

// ---------------------------------------------------------------- sample data
const me = () => useSession.getState().user
let sampleCodes: string[] = [...DEFAULT_VITALS]
let sampleRows: Vital[] | null = null
const sampleSeed = (): Vital[] => {
  const at = new Date().toISOString()
  return [
    { id: 'ob-1', code: 'bp_sys', value: 128, unit: 'mmHg', label: null, at },
    { id: 'ob-2', code: 'bp_dia', value: 84, unit: 'mmHg', label: null, at },
    { id: 'ob-3', code: 'temp', value: 38.2, unit: '°C', label: null, at },
    { id: 'ob-4', code: 'pulse', value: 96, unit: 'bpm', label: null, at },
  ].map((v) => ({ ...v, measuredBy: 'Nyirahabimana Chantal', enteredBy: 'Nyirahabimana Chantal' }))
}
/** Sample mode: the sample visit's measurements (the same for every sample visit). */
export function sampleVitalsOf(encounterId: string): Vital[] {
  void encounterId
  if (!sampleRows) sampleRows = sampleSeed()
  return sampleRows.map((v) => ({ ...v }))
}
/** Sample mode: record_vitals (the latest value of each code is kept). */
export function sampleSaveVitals(
  vitals: VitalsInput,
  o: {
    measuredBy?: string | null
    measuredAt?: string | null
    takers?: { id: string; name: string }[]
  },
) {
  const rows = sampleVitalsOf('')
  const at = o.measuredAt ?? new Date().toISOString()
  const who = o.measuredBy
    ? (o.takers?.find((p) => p.id === o.measuredBy)?.name ?? null)
    : (me()?.name ?? null)
  for (const [code, raw] of Object.entries(vitals)) {
    const entry: VitalEntry | null =
      typeof raw === 'string'
        ? raw.trim() === '' || !Number.isFinite(Number(raw.replace(',', '.')))
          ? null
          : { value: Number(raw.replace(',', '.')), unit: null, label: null }
        : raw
    if (!entry) continue
    const unit = entry.unit ?? vitalType(code)?.unit ?? null
    const row: Vital = {
      id: `ob-${Math.random().toString(36).slice(2, 8)}`,
      code,
      value: entry.value,
      unit,
      label: entry.label,
      at,
      measuredBy: who,
      enteredBy: me()?.name ?? null,
    }
    const i = rows.findIndex((r) => r.code === code)
    if (i >= 0) rows[i] = row
    else rows.push(row)
  }
  sampleRows = rows
}

const KEY = ['settings', 'vitals'] as const

// ---------------------------------------------------------------- the default set
/** The clinic's default set of measurements, in order (every signed-in staff member reads it). */
export function useVitalsSetting() {
  return useQuery({
    queryKey: KEY,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<VitalsSetting> => {
      if (!supabase) return { codes: [...sampleCodes] }
      const { data, error } = await supabase.rpc('vitals_setting')
      if (error) {
        // a database older than 0102: the nine of before
        if (isMissingFunction(error)) return { codes: [...DEFAULT_VITALS] }
        throw apiError(error)
      }
      const codes = (data as { codes?: unknown } | null)?.codes
      return {
        codes: Array.isArray(codes)
          ? codes.filter((c): c is string => typeof c === 'string' && SETTABLE_VITALS.includes(c))
          : [...DEFAULT_VITALS],
      }
    },
  })
}

/** Manager: which measurements the nurse sees by default, and in which order. */
export function useSaveVitalsSetting() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (codes: string[]) => {
      const clean = codes.filter((c, i) => SETTABLE_VITALS.includes(c) && codes.indexOf(c) === i)
      if (clean.length === 0) throw sampleRefusal('vitalUnknown', '22023')
      if (!supabase) {
        sampleCodes = clean
        return
      }
      const { error } = await supabase.rpc('save_vitals_setting', { p_codes: clean })
      if (error) throw apiError(error)
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  })
}

// ---------------------------------------------------------------- removing one
/**
 * A measurement taken off a visit's vital signs, with a reason (the row stays, the audit keeps
 * the value). Refusals: reasonNeeded, notFound, alreadyRemoved, visitClosed, or not allowed.
 */
export function useRemoveVital() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }): Promise<void> => {
      if (reason.trim().length < 3) throw sampleRefusal('reasonNeeded', '22023')
      if (!supabase) {
        const rows = sampleVitalsOf('')
        if (!rows.some((r) => r.id === id)) throw sampleRefusal('notFound', 'P0002')
        sampleRows = rows.filter((r) => r.id !== id)
        return
      }
      const { error } = await supabase.rpc('remove_vital', { p_id: id, p_reason: reason.trim() })
      if (error) throw apiError(error)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['visit'] })
      void qc.invalidateQueries({ queryKey: ['patients'] })
      void qc.invalidateQueries({ queryKey: ['queue'] })
    },
  })
}
