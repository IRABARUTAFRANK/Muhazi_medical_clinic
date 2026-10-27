import { createElement, type CSSProperties, type ReactNode } from 'react'
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  CircleCheck,
  Info,
  Minus,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatNumber } from '@mmc/shared'
import { useCountUp } from '@/lib/motion'
import { cn } from '@/lib/utils'

/*
 * Dashboard kit: KPI tiles on a tint wash with a coloured icon chip, white panels with a soft
 * shadow and a 40 px gradient header band in their hue, 16 px section titles, coloured tags and
 * 40 px list rows. Every dashboard (manager, head of station, front desk, nursing) is built from
 * these so they share one look: 10 px corners, soft shadows, light washes and bands. Motion is
 * small and purposeful: tiles and panels enter staggered (anim-enter with --i), a figure counts
 * up once, a sparkline draws itself; a tile that is a link lifts 1 px on hover.
 */

import { ShownList } from '@/components/ui/list-tools'
import { DashLink } from './dash-link'
import {
  headerBand,
  tagClass,
  tileClass,
  tintClass,
  type Hue,
  card,
  sectionTitle,
  stationIconFor,
} from './kit-style'

/** A figure that counts up once to its value (instant under reduced motion), formatted. */
export function CountUp({ value }: { value: number }) {
  return <>{formatNumber(useCountUp(value))}</>
}

export function Kpi({
  i,
  icon: IconC,
  tint,
  label,
  value,
  unit,
  delta: d,
  spark,
  text,
  to,
}: {
  i: number
  icon: LucideIcon
  tint: Hue
  label: string
  value: number
  unit: string
  /** Shown instead of the number (e.g. "2 h 05 min"). */
  text?: string
  delta?: { text: string; good: boolean | null; up: boolean | null }
  spark?: number[]
  /** The detailed view behind the figure (an app address): the whole tile becomes a link with a
   *  small "Details" mark. Left out, the tile is a plain card. */
  to?: string
}) {
  const { t } = useTranslation()
  const Arrow = d ? (d.up === null ? Minus : d.up ? ArrowUp : ArrowDown) : Minus
  // the delta tag sits on the tinted tile, so it is white with its colour as text and border
  const tag = d
    ? d.good === null
      ? 'border-border bg-card text-ink-2'
      : d.good
        ? 'border-green/30 bg-card text-green'
        : 'border-red/30 bg-card text-red'
    : ''
  const className = cn(
    card,
    'anim-enter relative gap-2 overflow-hidden',
    tileClass[tint],
    to && linkCard,
  )
  const style = { '--i': i } as CSSProperties
  const body = (
    <>
      {/* The Details mark sits in the corner so the label keeps the whole width and wraps by
          word only (break-words broke "Patients registered" into letters in a thin tile). */}
      {to && (
        <span className="text-ink-2 group-hover:text-primary group-focus-visible:text-primary absolute top-3 right-3 inline-flex items-center gap-0.5 text-[12px]">
          <span className="hidden lg:inline">{t('dashboard.links.details')}</span>
          <ArrowUpRight size={13} aria-hidden="true" />
        </span>
      )}
      <span className={cn('flex items-start gap-2 text-[13px] font-medium', to && 'pr-6 lg:pr-16')}>
        <IconChip icon={IconC} tint={tint} />
        <span className="text-ink-2 min-w-0 flex-1 pt-1 [text-wrap:balance] [overflow-wrap:normal]">
          {label}
        </span>
      </span>
      <span
        className={cn(
          'flex flex-wrap items-baseline gap-1.5 font-semibold tracking-[-0.01em] tabular-nums',
          // a sentence in place of a number ("Not enough data") reads at a text size
          text && text.length > 6 ? 'text-[18px] leading-6' : 'text-[28px] leading-8',
        )}
      >
        {text ?? <CountUp value={value} />}
        <small className="text-ink-2 text-[13px] font-normal">{unit}</small>
      </span>
      {(d || (spark && spark.length > 1)) && (
        <span className="flex items-end justify-between gap-2">
          {d ? (
            <span
              className={cn(
                'inline-flex min-h-6 min-w-0 items-center gap-1 rounded border px-2 py-0.5 text-[12px] leading-tight font-medium tabular-nums',
                tag,
              )}
            >
              <Arrow size={12} strokeWidth={2.5} aria-hidden="true" className="flex-none" />
              <span className="min-w-0">{d.text}</span>
            </span>
          ) : (
            <span />
          )}
          {spark && spark.length > 1 && <Sparkline values={spark} />}
        </span>
      )}
    </>
  )
  return to ? (
    <DashLink href={to} className={className} style={style}>
      {body}
    </DashLink>
  ) : (
    <div className={className} style={style}>
      {body}
    </div>
  )
}

/** A card that is a link: the text keeps its colours, the card lifts 1 px with a deeper shadow
 *  on hover (120 ms, .lift), the focus ring shows for the keyboard. */
const linkCard =
  'group lift cursor-pointer text-inherit no-underline outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20'

/** "Details →" at the top of a panel: the detailed view behind it. */
function DetailsLink({ to, label, title }: { to: string; label?: string; title: string }) {
  const { t } = useTranslation()
  return (
    <DashLink
      href={to}
      aria-label={label ? undefined : t('dashboard.links.detailsOf', { what: title })}
      className="text-primary hover:bg-card focus-visible:ring-primary/20 inline-flex h-7 flex-none items-center gap-1 rounded-md px-2 text-[13px] font-medium whitespace-nowrap no-underline outline-none focus-visible:ring-2"
    >
      {label ?? t('dashboard.links.details')}
      <ArrowRight size={14} aria-hidden="true" />
    </DashLink>
  )
}

/** Thin line in the tile's colour at the end of its last row; it draws itself in once. */
export function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values)
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * 84},${34 - (v / max) * 28}`)
    .join(' ')
  return (
    <svg
      viewBox="0 0 84 34"
      className="pointer-events-none hidden h-[28px] w-[70px] flex-none opacity-60 sm:block"
      aria-hidden="true"
    >
      <polyline
        points={pts}
        pathLength={1}
        className="draw-line"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
      />
    </svg>
  )
}

/** Small tinted square holding an icon: 32 px before tile and panel titles, 28 px in rows. */
export function IconChip({
  icon: IconC,
  tint = 'teal',
  size = 'md',
}: {
  icon: LucideIcon
  tint?: Hue
  size?: 'sm' | 'md'
}) {
  return (
    <span
      className={cn(
        'inline-flex flex-none items-center justify-center rounded',
        size === 'sm' ? 'size-7' : 'size-8',
        tintClass[tint],
      )}
    >
      <IconC size={size === 'sm' ? 16 : 18} aria-hidden="true" />
    </span>
  )
}

/** Section title with its icon ("Money", "Operations"): 16 px semibold with a teal rule below. */
export function SectionTitle({ icon: IconC, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className={cn(sectionTitle, 'border-primary/30 flex items-center gap-2 border-b pb-2')}>
      <IconC size={18} aria-hidden="true" className="text-primary" />
      {children}
    </div>
  )
}

/** Icon for a queue station (consultation → stethoscope); falls back to a stethoscope. */
export function StationGlyph({
  station,
  size = 18,
  className,
}: {
  station: string
  size?: number
  className?: string
}) {
  return createElement(stationIconFor(station), {
    size,
    className,
    'aria-hidden': true,
  })
}

export function Panel({
  i,
  title,
  icon,
  tint = 'teal',
  right,
  to,
  toLabel,
  children,
  className,
}: {
  i: number
  title: string
  /** Icon chip before the title, so each panel is recognisable at a glance. */
  icon?: LucideIcon
  tint?: Hue
  right?: ReactNode
  /** The detailed view behind the panel (an app address): a "Details →" link in the header. */
  to?: string
  /** The link's words instead of "Details" (e.g. "Waiting times"). */
  toLabel?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(card, 'anim-enter gap-0 p-0', className)}
      style={{ '--i': i } as CSSProperties}
    >
      {/* 40 px header band (the hue's tint fading to white): icon and title left, note and link right */}
      <h3
        className={cn(
          'border-border m-0 flex min-h-10 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b px-4 py-1.5 text-[16px] font-semibold',
          headerBand(tint),
        )}
      >
        <span className="flex min-w-0 flex-[1_1_180px] items-center gap-2">
          {icon && <IconChip icon={icon} tint={tint} size="sm" />}
          <span className="text-ink min-w-0 break-words">{title}</span>
        </span>
        {(right || to) && (
          <span className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-x-2 gap-y-1">
            {right && <span className="text-ink-2 text-[13px] font-normal">{right}</span>}
            {to && <DetailsLink to={to} label={toLabel} title={title} />}
          </span>
        )}
      </h3>
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">{children}</div>
    </section>
  )
}

/** Small bordered tag in a tint, with an optional symbol before the text. */
export function Pill({
  tint,
  icon,
  children,
}: {
  tint: Hue
  /** Small symbol before the text (clock for a time, siren for red). */
  icon?: LucideIcon
  children: ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex h-6 min-w-6 flex-none items-center justify-center gap-1 rounded border px-2 text-[12px] leading-none font-medium whitespace-nowrap tabular-nums',
        tagClass[tint],
      )}
    >
      {icon && createElement(icon, { size: 12, strokeWidth: 2.5, 'aria-hidden': true })}
      {children}
    </span>
  )
}

export function ListRows({
  rows,
  step = 6,
}: {
  /** Rows shown before "Show more" (long lists stay short on dashboards). */
  step?: number
  rows: {
    key: string
    pill?: ReactNode
    /** Icon chip at the start of the row. */
    icon?: LucideIcon
    tint?: Hue
    label: string
    value: string
    /** The row opens this app address (keyboard and pointer). */
    to?: string
  }[]
}) {
  return (
    <ShownList items={rows} step={step}>
      {(shown) => (
        <div className="flex flex-col">
          {shown.map((r, i) => {
            const row =
              'border-grid flex min-h-10 items-center gap-2.5 border-b py-1.5 text-[14px] last:border-b-0'
            const style = { '--i': i } as CSSProperties
            const content = (
              <>
                {r.icon && <IconChip icon={r.icon} tint={r.tint} size="sm" />}
                {r.pill}
                {/* the whole label wraps (a medicine with its strength, a full name) */}
                <span className="min-w-0 flex-1 wrap-break-word">{r.label}</span>
                <span className="font-medium whitespace-nowrap tabular-nums">{r.value}</span>
                {r.to && (
                  <ArrowRight
                    size={14}
                    aria-hidden="true"
                    className="text-ink-3 group-hover:text-primary flex-none"
                  />
                )}
              </>
            )
            return r.to ? (
              <DashLink
                key={r.key}
                href={r.to}
                className={cn(
                  row,
                  'group hover:bg-hover focus-visible:ring-primary/20 -mx-2 rounded px-2 text-inherit no-underline transition-colors duration-120 outline-none focus-visible:ring-2',
                )}
                style={style}
              >
                {content}
              </DashLink>
            ) : (
              <div key={r.key} className={row} style={style}>
                {content}
              </div>
            )
          })}
        </div>
      )}
    </ShownList>
  )
}

export function Empty({
  children,
  icon = CircleCheck,
}: {
  children: ReactNode
  icon?: LucideIcon
}) {
  return (
    <p className="text-ink-3 m-0 flex items-center gap-2 py-1 text-[14px]">
      {createElement(icon, { size: 16, className: 'text-green flex-none', 'aria-hidden': true })}
      {children}
    </p>
  )
}

/** Explanatory line under a panel, with an info symbol. */
export function Hint({ children }: { children: ReactNode }) {
  return (
    <p className="text-ink-3 m-0 flex items-start gap-1.5 text-[13px]">
      <Info size={14} aria-hidden="true" className="mt-0.5 flex-none" />
      <span>{children}</span>
    </p>
  )
}
