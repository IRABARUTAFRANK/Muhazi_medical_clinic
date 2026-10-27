import {
  Activity,
  AlertTriangle,
  BedDouble,
  CircleCheck,
  CircleDashed,
  ClipboardList,
  ConciergeBell,
  Crown,
  FlaskConical,
  HeartHandshake,
  HeartPulse,
  Pill,
  Ribbon,
  Scan,
  Scissors,
  Siren,
  Smile,
  Stethoscope,
  Syringe,
  type LucideIcon,
  Wallet,
} from 'lucide-react'
import { formatNumber, type Role } from '@mmc/shared'

/*
 * Style tokens and helpers shared by every dashboard (see kit.tsx for the components).
 * The tints are the health palette of tokens.css: teal (the clinic), mint (healthy, done, paid),
 * amber (waiting), coral (critical, due), violet (laboratory), navy (the clinical blue:
 * information), rose (maternity, family planning).
 * The console structure with the first design's richness: white cards with 10 px corners, a 1 px
 * border at 8 % navy and a soft shadow; 16 px semibold titles; tiles on a tint wash with a
 * 1 px border in the hue; header bands as a light gradient in the hue; coloured icon chips and
 * tags. The six "tints" are the subjects the dashboards pass.
 */
export const sectionTitle = 'text-[16px] font-semibold text-ink'
export const card =
  'bg-card border-card-border shadow-card flex min-w-0 flex-col gap-3 rounded-lg2 border p-4'

/* Tables and lists of every page: 40 px rows on 1 px dividers, a 12 px grey header row, the
 * first column medium, a soft hover tint and a soft teal tint on the selected row (never a
 * strong fill). */
export const tableHead = 'text-ink-3 h-10 px-3 text-left text-[12px] font-normal whitespace-nowrap'
export const tableRow =
  'border-grid hover:bg-hover h-10 border-b transition-colors duration-120 last:border-b-0'
export const tableCell = 'px-3 py-1.5 align-middle text-[14px]'
export const tableFirstCell = 'px-3 py-1.5 align-middle text-[14px] font-medium'
/** The selected row (its panel or detail is open): primary tint at 50 %. */
export const selectedRow = 'bg-primary-tint/50'
/** An expanded section inside a card. */
export const expandedSection = 'bg-surface'
/** A form card that has the focus: 1 px teal border. */
export const focusedForm = 'border-primary'

export type TFn = (key: string, opts?: Record<string, unknown>) => string
export type Tint = 'teal' | 'mint' | 'amber' | 'coral' | 'violet' | 'navy'
/** The tints plus rose (maternity, family planning): what the kit paints; pages keep `Tint`. */
export type Hue = Tint | 'rose'
/** Light tint with its text colour: icon chips and avatars. */
export const tintClass: Record<Hue, string> = {
  teal: 'bg-primary-tint text-primary',
  mint: 'bg-green-bg text-green',
  amber: 'bg-amber-bg text-amber',
  coral: 'bg-red-bg text-red',
  violet: 'bg-violet-bg text-violet',
  navy: 'bg-blue-bg text-navy-ink',
  rose: 'bg-rose-bg text-rose',
}
/** The same tint as a 1 px bordered tag (pills, counts, states). */
export const tagClass: Record<Hue, string> = {
  teal: 'border-primary/30 bg-primary-tint text-primary',
  mint: 'border-green/30 bg-green-bg text-green',
  amber: 'border-amber/30 bg-amber-bg text-amber',
  coral: 'border-red/30 bg-red-bg text-red',
  violet: 'border-violet/30 bg-violet-bg text-violet',
  navy: 'border-navy/30 bg-blue-bg text-navy-ink',
  rose: 'border-rose/30 bg-rose-bg text-rose',
}
/** A tile in the tint: the first design's wash (the tint at the corner fading into white by
 *  70 %, .wash-* in globals.css) with a 1 px border in the hue at 30 %. */
export const tileClass: Record<Hue, string> = {
  teal: 'border-primary/30 wash wash-teal',
  mint: 'border-green/30 wash wash-mint',
  amber: 'border-amber/30 wash wash-amber',
  coral: 'border-red/30 wash wash-coral',
  violet: 'border-violet/30 wash wash-violet',
  navy: 'border-navy/30 wash wash-navy',
  rose: 'border-rose/30 wash wash-rose',
}
/** The same tint as a solid light background (a selected row, a soft callout), no wash. */
export const solidTint: Record<Hue, string> = {
  teal: 'border-primary/30 bg-primary-tint',
  mint: 'border-green/30 bg-green-bg',
  amber: 'border-amber/30 bg-amber-bg',
  coral: 'border-red/30 bg-red-bg',
  violet: 'border-violet/30 bg-violet-bg',
  navy: 'border-navy/30 bg-blue-bg',
  rose: 'border-rose/30 bg-rose-bg',
}
/** The 3 px coloured left edge of a band (identity and page headers). */
export const edgeClass: Record<Hue, string> = {
  teal: 'border-l-primary',
  mint: 'border-l-green-dot',
  amber: 'border-l-yellow-dot',
  coral: 'border-l-red-dot',
  violet: 'border-l-violet-dot',
  navy: 'border-l-blue-dot',
  rose: 'border-l-rose-dot',
}
/** Strong text colour of each tint (figures and icons that carry a subject). Titles stay ink. */
export const tintText: Record<Hue, string> = {
  teal: 'text-primary',
  mint: 'text-green',
  amber: 'text-amber',
  coral: 'text-red',
  violet: 'text-violet',
  navy: 'text-navy-ink',
  rose: 'text-rose',
}
/** Coloured top edge of a panel (kept for callers; the kit's panels no longer use it). */
export const tintBorder: Record<Hue, string> = {
  teal: 'border-t-primary',
  mint: 'border-t-green-dot',
  amber: 'border-t-amber',
  coral: 'border-t-red-dot',
  violet: 'border-t-violet',
  navy: 'border-t-blue-dot',
  rose: 'border-t-rose-dot',
}
/** Light tint colour as a CSS value (kept for callers; the kit paints solid tints, never washes). */
export const tintWash: Record<Hue, string> = {
  teal: 'var(--mmc-primary-tint)',
  mint: 'var(--mmc-green-bg)',
  amber: 'var(--mmc-amber-bg)',
  coral: 'var(--mmc-red-bg)',
  violet: 'var(--mmc-violet-bg)',
  navy: 'var(--mmc-blue-bg)',
  rose: 'var(--mmc-rose-bg)',
}
/** A hue name as the pages and panels write it; `lavender` and `blue` are the kit's violet
 *  and navy, `grey` is for settings and notifications. */
export type BandHue = Hue | 'grey' | 'lavender' | 'blue'
const bandHue = (hue: BandHue) => (hue === 'lavender' ? 'violet' : hue === 'blue' ? 'navy' : hue)
/**
 * Header band of a panel, card or dialog: a light gradient from the hue's tint to white
 * (classes .band-* in globals.css, dim-aware) under the icon chip and the 16 px title.
 * Side panels, dialogs and page banners use the strong `heroBand`.
 */
export const headerBand = (hue: BandHue = 'teal') => `band band-${bandHue(hue)}`
/**
 * Strong band in the hue (`linear-gradient(135deg, hue, hue-deep)`, white text, a faint dot
 * grid): the identity band, page banners, side-panel and dialog headers (.hero-* in globals.css).
 */
export const heroBand = (hue: BandHue = 'teal') => `hero hero-${bandHue(hue)}`

/** Initials discs in lists: a tint per person, cycling. */
export const avatarTint = (i: number) =>
  tintClass[(['teal', 'mint', 'violet', 'amber', 'coral', 'navy'] as Tint[])[i % 6]!]
export const initials = (name: string) =>
  name
    .replace(/^Dr\.?\s+/i, '')
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')

export function delta(now: number, prev: number, upIsGood: boolean, t: TFn) {
  const diff = now - prev
  if (diff === 0)
    return {
      text: t('dashboard.noChange'),
      good: null as boolean | null,
      up: null as boolean | null,
    }
  const pct = prev === 0 ? null : Math.round((diff / prev) * 100)
  return {
    text: t('dashboard.vsPrevious', {
      change: `${diff > 0 ? '+' : '−'}${formatNumber(Math.abs(diff))}${pct != null ? ` (${pct > 0 ? '+' : ''}${pct} %)` : ''}`,
    }),
    good: upIsGood ? diff > 0 : diff < 0,
    up: diff > 0,
  }
}

export const stationLabel = (s: string, t: TFn) => {
  const key = `register.stations.${s.toLowerCase()}`
  const v = t(key)
  return v === key ? s : v
}

export const groupLabel = (g: string, t: TFn) => {
  const key = `prices.groups.${g}`
  const v = t(key)
  return v === key ? g : v
}

/** "Good morning, Théogène": by the hour, with the name the person is called by. */
export const greetingFor = (name: string, t: TFn) => {
  const hour = new Date().getHours()
  return t(`dashboard.greeting.${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}`, {
    name: name
      .replace(/^Dr\.?\s+/i, '')
      .split(' ')
      .pop(),
  })
}

/** Each role's icon and tint (the health palette: the manager in the clinic's teal, the doctor
 *  in the clinical blue, nurse and pharmacist in mint, the laboratory in lavender, the cashier
 *  in amber, reception in rose): the identity band, its avatar ring and the role tag. */
const ROLE_LOOK: Record<Role, { icon: LucideIcon; tint: Hue; stripe: string }> = {
  manager: { icon: Crown, tint: 'teal', stripe: 'bg-primary' },
  receptionist: { icon: ConciergeBell, tint: 'rose', stripe: 'bg-rose-dot' },
  nurse: { icon: HeartPulse, tint: 'mint', stripe: 'bg-green-dot' },
  doctor: { icon: Stethoscope, tint: 'navy', stripe: 'bg-blue-dot' },
  cashier: { icon: Wallet, tint: 'amber', stripe: 'bg-yellow-dot' },
  lab_tech: { icon: FlaskConical, tint: 'violet', stripe: 'bg-violet-dot' },
  pharmacist: { icon: Pill, tint: 'mint', stripe: 'bg-green-dot' },
}
export const lookFor = (role: Role) => ROLE_LOOK[role] ?? ROLE_LOOK.doctor

/** Solid colour of each tint (dots, avatar badges). */
export const stripeClass: Record<Hue, string> = {
  teal: 'bg-primary',
  mint: 'bg-green-dot',
  amber: 'bg-yellow-dot',
  coral: 'bg-red-dot',
  violet: 'bg-violet-dot',
  navy: 'bg-blue-dot',
  rose: 'bg-rose-dot',
}

const STATION_ICONS: Record<string, LucideIcon> = {
  triage: Activity,
  consultation: Stethoscope,
  dental: Smile,
  laboratory: FlaskConical,
  lab: FlaskConical,
  ultrasound: Scan,
  imaging: Scan,
  nursing: Syringe,
  procedures: Syringe,
  procedure: Scissors,
  bed: BedDouble,
  registration: ClipboardList,
  theatre: Scissors,
  surgery: Scissors,
  pharmacy: Pill,
  medicines: Pill,
  cashier: Wallet,
  beds: BedDouble,
  reception: ConciergeBell,
}
/** Icon for a station or service group (consultation → stethoscope); stethoscope when unknown. */
export const stationIconFor = (station: string): LucideIcon => {
  const s = station.toLowerCase()
  if (STATION_ICONS[s]) return STATION_ICONS[s]
  // Named service groups ("HIV testing & vaccination", "Family planning", …)
  if (s.includes('hiv')) return Ribbon
  if (s.includes('vaccin') || s.includes('inject')) return Syringe
  if (s.includes('family')) return HeartHandshake
  if (s.includes('surg') || s.includes('circum')) return Scissors
  const hit = Object.keys(STATION_ICONS).find((k) => s.includes(k))
  return hit ? STATION_ICONS[hit]! : Stethoscope
}

/** Triage colour symbols: siren for red, warning for yellow, check for green. */
export const triageIcon: Record<string, LucideIcon> = {
  red: Siren,
  yellow: AlertTriangle,
  green: CircleCheck,
  none: CircleDashed,
}
