import {
  Activity,
  AlertTriangle,
  BedDouble,
  CircleCheck,
  ConciergeBell,
  Crown,
  FlaskConical,
  HeartHandshake,
  HeartPulse,
  ClipboardList,
  Pill,
  Ribbon,
  Scan,
  Scissors,
  Siren,
  Smile,
  Stethoscope,
  Syringe,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { formatNumber, type Role } from '@mmc/shared'

/** Style tokens and helpers shared by every dashboard (see kit.tsx for the components). */
export const sectionTitle = 'text-[13px] font-extrabold tracking-[.08em] text-primary uppercase'
export const card =
  'card-lift bg-card shadow-card flex min-w-0 flex-col gap-3 rounded-[16px] px-4 py-4 sm:gap-3.5 sm:px-5 sm:py-[18px]'

export type TFn = (key: string, opts?: Record<string, unknown>) => string
export type Tint = 'teal' | 'mint' | 'amber' | 'coral' | 'violet' | 'navy'
export const tintClass: Record<Tint, string> = {
  teal: 'bg-primary-tint text-primary',
  mint: 'bg-green-bg text-green',
  amber: 'bg-amber-bg text-amber',
  coral: 'bg-red-bg text-red',
  violet: 'bg-violet-bg text-violet',
  navy: 'bg-blue-bg text-navy',
}
/** Strong text colour of each tint (panel titles, KPI labels). */
export const tintText: Record<Tint, string> = {
  teal: 'text-primary',
  mint: 'text-green',
  amber: 'text-amber',
  coral: 'text-red',
  violet: 'text-violet',
  navy: 'text-navy-ink',
}
/** Coloured top edge of a panel. */
export const tintBorder: Record<Tint, string> = {
  teal: 'border-t-primary',
  mint: 'border-t-green-dot',
  amber: 'border-t-yellow-dot',
  coral: 'border-t-red-dot',
  violet: 'border-t-violet',
  navy: 'border-t-navy',
}
/** Soft wash of a tint fading into the card (top of panels, KPI tiles, banners). */
export const tintWash: Record<Tint, string> = {
  teal: 'var(--mmc-primary-tint)',
  mint: 'var(--mmc-green-bg)',
  amber: 'var(--mmc-amber-bg)',
  coral: 'var(--mmc-red-bg)',
  violet: 'var(--mmc-violet-bg)',
  navy: 'var(--mmc-blue-bg)',
}
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

/** Each role's icon and colour: banner stripe, avatar badge and role pill. */
const ROLE_LOOK: Record<Role, { icon: LucideIcon; tint: Tint; stripe: string }> = {
  manager: { icon: Crown, tint: 'navy', stripe: 'bg-navy' },
  receptionist: { icon: ConciergeBell, tint: 'teal', stripe: 'bg-primary' },
  nurse: { icon: HeartPulse, tint: 'mint', stripe: 'bg-green' },
  doctor: { icon: Stethoscope, tint: 'violet', stripe: 'bg-violet' },
  cashier: { icon: Wallet, tint: 'amber', stripe: 'bg-amber' },
  lab_tech: { icon: FlaskConical, tint: 'coral', stripe: 'bg-red' },
}
export const lookFor = (role: Role) => ROLE_LOOK[role] ?? ROLE_LOOK.doctor

/** Banner stripe colour for each tint. */
export const stripeClass: Record<Tint, string> = {
  teal: 'bg-primary',
  mint: 'bg-green',
  amber: 'bg-amber',
  coral: 'bg-red',
  violet: 'bg-violet',
  navy: 'bg-navy',
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
}
