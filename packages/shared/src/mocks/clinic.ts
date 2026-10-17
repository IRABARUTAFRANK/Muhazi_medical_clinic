import type { CategoryFilter, CategoryId, ClinicHours, ClinicProfile } from '../types'

/** Sample clinic profile; live data comes from the `clinic.profile` setting. */
export const CLINIC_PROFILE: ClinicProfile = {
  name: 'Muhazi Medical Clinic',
  tagline: 'Quality care, healthy life.',
  sector: 'Kiramuruzi',
  district: 'Gatsibo',
  province: 'Eastern Province',
  country: 'Rwanda',
  phone: '0799476752',
  whatsapp: '0799476752',
  email: 'muhazimedicalclinicltd@gmail.com',
}

/** Sample opening hours; live data comes from the `clinic.hours` setting. */
export const CLINIC_HOURS: ClinicHours = {
  timezone: 'Africa/Kigali',
  days: {
    '0': ['00:00', '24:00'],
    '1': ['00:00', '24:00'],
    '2': ['00:00', '24:00'],
    '3': ['00:00', '24:00'],
    '4': ['00:00', '24:00'],
    '5': ['00:00', '24:00'],
    '6': ['00:00', '24:00'],
  },
  lab: ['00:00', '24:00'],
}

export const CLINIC = {
  name: CLINIC_PROFILE.name,
  systemName: 'Clinic System',
  version: '1.0',
  place: 'Kiramuruzi · Gatsibo · Rwanda',
  town: 'Kiramuruzi',
  district: 'Gatsibo',
  province: 'Eastern Province',
  phone: CLINIC_PROFILE.phone,
  whatsapp: CLINIC_PROFILE.whatsapp,
  email: CLINIC_PROFILE.email,
  /** Google Maps pin of the clinic (shared link); the embed uses its coordinates. */
  mapsUrl: 'https://maps.app.goo.gl/UEpB7oHnxb8fkxs18',
  // t=k = satellite imagery by default
  mapsEmbedUrl: 'https://www.google.com/maps?q=-1.797670,30.416055&z=17&t=k&output=embed',
  emergencyNumber: '912',
  /** Sample "clinic now" numbers used when no live status is available. */
  currentWaitMin: 18,
  currentWaiting: 11,
} as const

/** Rwandan mobile numbers as people dial them: 0799 476 752; links use +250. */
export const formatPhone = (p: string): string =>
  p.replace(/\D/g, '').replace(/^(\d{4})(\d{3})(\d{3})$/, '$1 $2 $3')
const intl = (p: string): string => p.replace(/\D/g, '').replace(/^0/, '').replace(/^250/, '')
export const telHref = (p: string): string => `tel:+250${intl(p)}`
export const whatsappHref = (p: string): string => `https://wa.me/250${intl(p)}`

/**
 * Features the clinic has not switched on yet. `insurance` stays off until the clinic signs its
 * first insurer: the public site then shows a "coming soon" band instead of partner names, and
 * the booking form hides the insurance field.
 */
export const FEATURES = {
  insurance: false,
} as const

/** Sample insurer names; empty until the clinic has partners (live: `public_payers`). */
export const INSURERS: readonly string[] = []

export const CATEGORY_FILTERS: readonly CategoryFilter[] = [
  'all',
  'consultation',
  'dental',
  'laboratory',
  'ultrasound',
  'nursing',
  'surgery',
  'fp',
  'hiv',
  'circ',
]
export const CATEGORY_IDS: readonly CategoryId[] = CATEGORY_FILTERS.filter(
  (c): c is CategoryId => c !== 'all',
)

export const isCategoryFilter = (value: unknown): value is CategoryFilter =>
  typeof value === 'string' && (CATEGORY_FILTERS as readonly string[]).includes(value)

/** "From" price of a public service line (live: `public_service_lines`). */
export interface ServiceLine {
  id: CategoryId
  priceFrom: number | null
  hasFree: boolean
  /** Icon name resolved by the UI layer. */
  icon: string
}

export const SERVICE_ICONS: Record<CategoryId, string> = {
  consultation: 'heart-pulse',
  laboratory: 'flask-conical',
  dental: 'smile',
  ultrasound: 'radio',
  nursing: 'bed',
  surgery: 'scissors',
  circ: 'shield-plus',
  fp: 'heart-handshake',
  hiv: 'shield-check',
}

/** Sample service lines (same values as the seed's cash price list). */
export const SERVICES: readonly ServiceLine[] = [
  { id: 'consultation', priceFrom: 5000, hasFree: false, icon: SERVICE_ICONS.consultation },
  { id: 'laboratory', priceFrom: 2500, hasFree: false, icon: SERVICE_ICONS.laboratory },
  { id: 'dental', priceFrom: 5000, hasFree: false, icon: SERVICE_ICONS.dental },
  { id: 'ultrasound', priceFrom: 20000, hasFree: false, icon: SERVICE_ICONS.ultrasound },
  { id: 'nursing', priceFrom: 1000, hasFree: true, icon: SERVICE_ICONS.nursing },
  { id: 'surgery', priceFrom: 25000, hasFree: false, icon: SERVICE_ICONS.surgery },
  { id: 'circ', priceFrom: 30000, hasFree: false, icon: SERVICE_ICONS.circ },
  { id: 'fp', priceFrom: null, hasFree: true, icon: SERVICE_ICONS.fp },
  { id: 'hiv', priceFrom: null, hasFree: true, icon: SERVICE_ICONS.hiv },
]
