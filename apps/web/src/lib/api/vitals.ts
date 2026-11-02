import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import type { Vital } from './billing'
import { apiError, isMissingFunction, sampleRefusal } from './errors'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'

/**
 * Vital signs the clinic chooses (migrations 0102, 0119).
 *
 * The catalogue below is the list of built-in measurements the form knows, each with its unit
 * and the values a living patient can have (newborn to adult, critically ill included): outside
 * them it is a typing mistake. The database holds the same catalogue (`vital_type`) and checks
 * the same limits. Since 0119 the manager adds measurements of the clinic's own in Settings
 * (code `custom_<slug>` from the name, a number with an optional range or a text), renames them,
 * retires them (hidden everywhere, what was recorded stays) and shows them again. A measurement
 * typed by name on a patient ("Other") joins the catalogue by itself.
 *
 * The clinic's default set (which measurements the nurse sees first, in which order) is the
 * setting `vitals.default`, chosen by the manager in Settings › Vital signs. BMI is computed on
 * the screens from weight and height, never stored.
 */

export type VitalKind = 'number' | 'text'
export interface VitalType {
  code: string
  unit: string
  /** The values a number may take; a custom measurement may have none. */
  min?: number
  max?: number
  /** An example value shown in the empty box. */
  placeholder: string
  /** The manager's name for a custom measurement (a built-in one is translated). */
  name: string | null
  kind: VitalKind
  /** Added by the clinic (custom_…): renamed or retired in Settings. */
  custom: boolean
  /** Retired by the manager: hidden from the forms, shown in Settings under "Retired". */
  retired?: boolean
}

const builtIn = (
  code: string,
  unit: string,
  min: number,
  max: number,
  placeholder: string,
): VitalType => ({ code, unit, min, max, placeholder, name: null, kind: 'number', custom: false })
/** The built-in measurements (the database's vital_type rows that are not custom). */
export const VITAL_CATALOGUE: readonly VitalType[] = [
  builtIn('bp_sys', 'mmHg', 40, 300, '120'),
  builtIn('bp_dia', 'mmHg', 20, 200, '80'),
  builtIn('pulse', 'bpm', 20, 250, '72'),
  builtIn('temp', '°C', 30, 44, '36.8'),
  builtIn('resp', '/min', 4, 100, '16'),
  builtIn('spo2', '%', 40, 100, '98'),
  builtIn('weight', 'kg', 0.3, 350, '65'),
  builtIn('height', 'cm', 20, 250, '170'),
  builtIn('muac', 'cm', 5, 60, ''),
  builtIn('glucose_mmol', 'mmol/L', 0.5, 60, '5.5'),
  builtIn('glucose_mgdl', 'mg/dL', 10, 1100, '100'),
  builtIn('pain', '/10', 0, 10, '0'),
  builtIn('head_circ', 'cm', 20, 70, ''),
  builtIn('urine_output', 'mL', 0, 10000, ''),
  builtIn('gcs', '/15', 3, 15, '15'),
  builtIn('fundal_height', 'cm', 5, 60, ''),
  builtIn('fhr', 'bpm', 60, 240, '140'),
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
/** What the manager can tick on a database before 0119: the built-in catalogue and the computed BMI. */
export const SETTABLE_VITALS: readonly string[] = [...VITAL_CATALOGUE.map((v) => v.code), BMI_CODE]

/** A built-in measurement by code (the clinic's own ones come with the setting's catalogue). */
export const vitalType = (code: string): VitalType | undefined =>
  VITAL_CATALOGUE.find((v) => v.code === code)
/** A measurement by code in a catalogue read from the database (built-in or the clinic's own). */
export const typeIn = (catalogue: readonly VitalType[], code: string): VitalType | undefined =>
  catalogue.find((v) => v.code === code)
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
/** The name of a measurement in the person's language (a custom one: as typed or as the manager named it). */
export function vitalName(
  v: { code: string; label?: string | null; name?: string | null },
  t: TFunction,
): string {
  if (v.label) return v.label
  if (v.name) return v.name
  if (v.code === BMI_CODE) return t('vitals.bmi')
  return t(`triage.vitals.${v.code}`, { defaultValue: v.code.replace(/^custom_/, '') })
}
/** The unit of a measurement: the catalogue's, or the one typed for a custom one. */
export const vitalUnit = (v: { code: string; unit?: string | null }): string =>
  v.unit ?? vitalType(v.code)?.unit ?? ''
/** What a measurement shows: its figure, or its words for a text one. */
export const vitalValue = (v: { value: number | null; text?: string | null }): string =>
  v.text ?? (v.value != null ? String(v.value) : '')
/** Body mass index from weight (kg) and height (cm), one decimal; null when either is missing. */
export function bmiOf(weightKg: number | null | undefined, heightCm: number | null | undefined) {
  if (!weightKg || !heightCm || weightKg <= 0 || heightCm <= 0) return null
  const m = heightCm / 100
  return Math.round((weightKg / (m * m)) * 10) / 10
}

/** One measurement sent to record_vitals: a custom one carries its unit and typed name; a text one its words. */
export interface VitalEntry {
  value: number | null
  unit: string | null
  label: string | null
  text?: string | null
}
/** The vitals as the form sends them: a typed number per catalogue code, an entry per custom one. */
export type VitalsInput = Record<string, string | VitalEntry>

export interface VitalsSetting {
  /** The default set, in order ('bmi' = the computed BMI). */
  codes: string[]
  /** What the forms offer: the built-in measurements and the clinic's own, the retired ones left out. */
  catalogue: VitalType[]
}

/** One row of the database's catalogue (vitals_setting().catalogue, vital_types()). */
interface TypeRow {
  code: string
  name?: string | null
  unit: string
  kind?: string | null
  min?: number | string | null
  max?: number | string | null
  custom?: boolean
  retired?: boolean
}
const num = (x: number | string | null | undefined): number | undefined => {
  if (x == null || x === '') return undefined
  const n = Number(x)
  return Number.isFinite(n) ? n : undefined
}
/** A database row as the screens know it: a built-in keeps its example value. */
const toType = (r: TypeRow): VitalType => {
  const known = vitalType(r.code)
  return {
    code: r.code,
    unit: r.unit ?? known?.unit ?? '',
    min: num(r.min) ?? known?.min,
    max: num(r.max) ?? known?.max,
    placeholder: known?.placeholder ?? '',
    name: isCustomVital(r.code) ? (r.name ?? null) : null,
    kind: r.kind === 'text' ? 'text' : 'number',
    custom: r.custom ?? isCustomVital(r.code),
    retired: !!r.retired,
  }
}

// ---------------------------------------------------------------- sample data
const me = () => useSession.getState().user
let sampleCodes: string[] = [...DEFAULT_VITALS]
/** Sample mode: the clinic's own measurements (one retired), as the manager made them. */
let sampleCustom: VitalType[] = [
  {
    code: 'custom_blood_ketones',
    name: 'Blood ketones',
    unit: 'mmol/L',
    kind: 'number',
    min: 0,
    max: 10,
    placeholder: '',
    custom: true,
    retired: false,
  },
  {
    code: 'custom_urine_dipstick',
    name: 'Urine dipstick',
    unit: '',
    kind: 'text',
    placeholder: '',
    custom: true,
    retired: false,
  },
  {
    code: 'custom_peak_flow',
    name: 'Peak flow',
    unit: 'L/min',
    kind: 'number',
    min: 50,
    max: 900,
    placeholder: '',
    custom: true,
    retired: true,
  },
]
const sampleCatalogue = (): VitalType[] => [
  ...VITAL_CATALOGUE,
  ...sampleCustom.filter((v) => !v.retired),
]
let sampleRows: Vital[] | null = null
const sampleSeed = (): Vital[] => {
  const at = new Date().toISOString()
  return [
    { id: 'ob-1', code: 'bp_sys', value: 128, unit: 'mmHg', label: null, text: null, at },
    { id: 'ob-2', code: 'bp_dia', value: 84, unit: 'mmHg', label: null, text: null, at },
    { id: 'ob-3', code: 'temp', value: 38.2, unit: '°C', label: null, text: null, at },
    { id: 'ob-4', code: 'pulse', value: 96, unit: 'bpm', label: null, text: null, at },
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
  // the person typing names themselves ("Me"): the same as naming nobody
  const who =
    o.measuredBy && o.measuredBy !== me()?.id
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
    const type = typeIn(sampleCatalogue(), code)
    const unit = entry.unit ?? type?.unit ?? null
    const row: Vital = {
      id: `ob-${Math.random().toString(36).slice(2, 8)}`,
      code,
      value: entry.text ? null : entry.value,
      unit,
      label: entry.label ?? type?.name ?? null,
      text: entry.text ?? null,
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
const TYPES_KEY = ['settings', 'vital-types'] as const

// ---------------------------------------------------------------- the default set and the catalogue
/**
 * The clinic's default set of measurements, in order, and the catalogue the forms offer (every
 * signed-in staff member reads it).
 */
export function useVitalsSetting() {
  return useQuery({
    queryKey: KEY,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<VitalsSetting> => {
      if (!supabase) return { codes: [...sampleCodes], catalogue: sampleCatalogue() }
      const { data, error } = await supabase.rpc('vitals_setting')
      if (error) {
        // a database older than 0102: the nine of before
        if (isMissingFunction(error))
          return { codes: [...DEFAULT_VITALS], catalogue: [...VITAL_CATALOGUE] }
        throw apiError(error)
      }
      const d = data as { codes?: unknown; catalogue?: unknown } | null
      // a database before 0119 lists the built-in ones only (without names and kinds)
      const catalogue = Array.isArray(d?.catalogue)
        ? (d!.catalogue as TypeRow[]).filter((r) => r && typeof r.code === 'string').map(toType)
        : [...VITAL_CATALOGUE]
      const codes = d?.codes
      return {
        codes: Array.isArray(codes)
          ? codes.filter(
              (c): c is string =>
                typeof c === 'string' && (c === BMI_CODE || catalogue.some((v) => v.code === c)),
            )
          : [...DEFAULT_VITALS],
        catalogue,
      }
    },
  })
}

/** Manager: which measurements the nurse sees by default, and in which order. */
export function useSaveVitalsSetting() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (codes: string[]) => {
      const clean = codes.filter((c, i) => codes.indexOf(c) === i && c.trim() !== '')
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

// ---------------------------------------------------------------- managing the measurements (0119)
/** Every measurement, the retired ones included (Settings › Vital signs). */
export function useVitalTypes() {
  return useQuery({
    queryKey: TYPES_KEY,
    staleTime: 60_000,
    queryFn: async (): Promise<VitalType[]> => {
      if (!supabase) return [...VITAL_CATALOGUE, ...sampleCustom.map((v) => ({ ...v }))]
      const { data, error } = await supabase.rpc('vital_types')
      if (error) {
        // a database before 0119: the built-in ones, nothing to manage
        if (isMissingFunction(error)) return [...VITAL_CATALOGUE]
        throw apiError(error)
      }
      return Array.isArray(data)
        ? (data as TypeRow[]).filter((r) => r && typeof r.code === 'string').map(toType)
        : [...VITAL_CATALOGUE]
    },
  })
}

export interface VitalTypeInput {
  /** null: a new measurement (its code comes from the name). */
  code: string | null
  name: string
  unit: string
  kind: VitalKind
  min: number | null
  max: number | null
}

const refreshTypes = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: KEY })
  void qc.invalidateQueries({ queryKey: TYPES_KEY })
}

/**
 * Manager: add a measurement of the clinic's own, or rename a custom one (its unit, kind and
 * range too). Refusals: vitalName, vitalKind, vitalRangeOrder, vitalExists, vitalExistsRetired,
 * vitalBuiltin, vitalRetired, vitalUnknown, or not allowed.
 */
export function useSaveVitalType() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (i: VitalTypeInput): Promise<VitalType> => {
      const name = i.name.trim()
      const unit = i.unit.trim()
      const min = i.kind === 'text' ? null : i.min
      const max = i.kind === 'text' ? null : i.max
      if (!name || name.length > 60) throw sampleRefusal('vitalName', '22023')
      if (unit.length > 20) throw sampleRefusal('vitalName', '22023')
      if (min != null && max != null && min >= max) throw sampleRefusal('vitalRangeOrder', '22023')
      if (!supabase) {
        const code = i.code ?? customVitalCode(name)
        const old = sampleCustom.find((v) => v.code === code)
        if (i.code === null && old)
          throw sampleRefusal(old.retired ? 'vitalExistsRetired' : 'vitalExists', '23505')
        if (i.code !== null && !isCustomVital(code)) throw sampleRefusal('vitalBuiltin', '22023')
        if (i.code !== null && !old) throw sampleRefusal('vitalUnknown', '22023')
        if (old?.retired) throw sampleRefusal('vitalRetired', '22023')
        const row: VitalType = {
          code,
          name,
          unit,
          kind: i.kind,
          min: min ?? undefined,
          max: max ?? undefined,
          placeholder: '',
          custom: true,
          retired: false,
        }
        sampleCustom = old
          ? sampleCustom.map((v) => (v.code === code ? row : v))
          : [...sampleCustom, row]
        return row
      }
      const { data, error } = await supabase.rpc('save_vital_type', {
        p_code: i.code,
        p_name: name,
        p_unit: unit,
        p_kind: i.kind,
        p_min: min,
        p_max: max,
      })
      if (error) throw apiError(error)
      return toType(data as TypeRow)
    },
    onSuccess: () => refreshTypes(qc),
  })
}

/**
 * Manager: a custom measurement retired (hidden from Settings and the forms; what was recorded
 * stays). Refusals: vitalInDefault (untick it first), vitalBuiltin, vitalRetired, vitalUnknown.
 */
export function useRetireVitalType() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (code: string): Promise<void> => {
      if (!supabase) {
        const v = sampleCustom.find((x) => x.code === code)
        if (!isCustomVital(code)) throw sampleRefusal('vitalBuiltin', '22023')
        if (!v) throw sampleRefusal('vitalUnknown', '22023')
        if (v.retired) throw sampleRefusal('vitalRetired', '22023')
        if (sampleCodes.includes(code)) throw sampleRefusal('vitalInDefault', '22023')
        v.retired = true
        return
      }
      const { error } = await supabase.rpc('retire_vital_type', { p_code: code })
      if (error) throw apiError(error)
    },
    onSuccess: () => refreshTypes(qc),
  })
}

/** Manager: "Show again" for a retired measurement. */
export function useRestoreVitalType() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (code: string): Promise<void> => {
      if (!supabase) {
        const v = sampleCustom.find((x) => x.code === code)
        if (!v) throw sampleRefusal('vitalUnknown', '22023')
        if (!v.retired) throw sampleRefusal('vitalNotRetired', '22023')
        v.retired = false
        return
      }
      const { error } = await supabase.rpc('restore_vital_type', { p_code: code })
      if (error) throw apiError(error)
    },
    onSuccess: () => refreshTypes(qc),
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
