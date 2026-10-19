import { formatNumber } from '@mmc/shared'

/** Style tokens and helpers shared by every dashboard (see kit.tsx for the components). */
export const sectionTitle = 'text-[11px] font-extrabold tracking-[.08em] text-ink-3 uppercase'
export const card =
  'card-lift bg-card shadow-card flex min-w-0 flex-col gap-3.5 rounded-[16px] px-5 py-[18px]'

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
