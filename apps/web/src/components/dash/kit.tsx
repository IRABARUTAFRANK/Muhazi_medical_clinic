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
 * Dashboard kit (Figma: "Muhazi Clinic — Manager Dashboard v2"): tinted KPI tiles with
 * count-up numbers, 16 px cards with a soft shadow, section titles, pills and list rows.
 * Every dashboard (manager, head of station, front desk, nursing) is built from these so
 * they share one look and one motion system.
 */

import { ShownList } from '@/components/ui/list-tools'
import { DashLink } from './dash-link'
import {
  tintBorder,
  tintClass,
  tintText,
  tintWash,
  type Tint,
  card,
  sectionTitle,
  stationIconFor,
} from './kit-style'
export function CountUp({ value }: { value: number }) {
  const v = useCountUp(value, 600)
  return <>{formatNumber(v)}</>
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
  tint: Tint
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
  const pill = d
    ? d.good === null
      ? 'bg-hover text-ink-2'
      : d.good
        ? 'bg-green-bg text-green'
        : 'bg-red-bg text-red'
    : ''
  const className = cn(
    card,
    'anim-enter relative gap-2 overflow-hidden px-3.5 pt-3.5 pb-3 sm:gap-2.5 sm:px-[18px] sm:pt-[18px] sm:pb-3.5',
    to && linkCard,
  )
  const style = {
    '--i': i,
    backgroundImage: `linear-gradient(150deg, ${tintWash[tint]} 0%, var(--mmc-card) 62%)`,
  } as CSSProperties
  const body = (
    <>
      {to && (
        <span className="text-ink-3 group-hover:text-primary group-focus-visible:text-primary absolute top-3 right-3 inline-flex items-center gap-0.5 text-[12px] font-semibold sm:top-4 sm:right-4">
          <span className="hidden sm:inline">{t('dashboard.links.details')}</span>
          <ArrowUpRight size={14} strokeWidth={2.5} aria-hidden="true" />
        </span>
      )}
      <span
        className={cn(
          'inline-flex size-10 items-center justify-center rounded-xl',
          tintClass[tint],
        )}
      >
        <IconC size={18} aria-hidden="true" />
      </span>
      <span
        className={cn(
          'text-[11px] font-bold tracking-[.04em] uppercase sm:text-[13px]',
          tintText[tint],
        )}
      >
        {label}
      </span>
      <span className="flex flex-wrap items-baseline gap-1.5 text-[26px] leading-none font-extrabold tracking-[-0.02em] tabular-nums sm:text-[32px]">
        {text ?? <CountUp value={value} />}
        <small className="text-ink-3 text-[14px] font-semibold">{unit}</small>
      </span>
      {d && (
        <span
          className={cn(
            'fade-in-late inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-bold tabular-nums',
            pill,
          )}
        >
          <Arrow size={12} strokeWidth={3} aria-hidden="true" />
          {d.text}
        </span>
      )}
      {spark && spark.length > 1 && <Sparkline values={spark} />}
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

/** A card that is a link: the text keeps its colours, the focus ring shows for the keyboard. */
const linkCard =
  'group cursor-pointer text-inherit no-underline outline-none focus-visible:ring-[3px] focus-visible:ring-primary/45 focus-visible:ring-offset-2 focus-visible:ring-offset-surface'

/** "Details →" at the top of a panel: the detailed view behind it. */
function DetailsLink({ to, label, title }: { to: string; label?: string; title: string }) {
  const { t } = useTranslation()
  return (
    <DashLink
      href={to}
      aria-label={label ? undefined : t('dashboard.links.detailsOf', { what: title })}
      className="text-primary hover:bg-primary-tint focus-visible:ring-primary/45 inline-flex flex-none items-center gap-1 rounded-lg px-2 py-1 text-[13px] font-bold whitespace-nowrap no-underline outline-none focus-visible:ring-[3px]"
    >
      {label ?? t('dashboard.links.details')}
      <ArrowRight size={14} strokeWidth={2.5} aria-hidden="true" />
    </DashLink>
  )
}

export function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values)
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * 84},${34 - (v / max) * 28}`)
    .join(' ')
  return (
    <svg
      viewBox="0 0 84 34"
      className="text-violet pointer-events-none absolute right-3 bottom-3 hidden h-[34px] w-[84px] sm:block"
      aria-hidden="true"
    >
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        pathLength={1}
        className="draw-line"
      />
    </svg>
  )
}

/** Small tinted square holding an icon, used before panel titles and in list rows. */
export function IconChip({
  icon: IconC,
  tint = 'teal',
  size = 'md',
}: {
  icon: LucideIcon
  tint?: Tint
  size?: 'sm' | 'md'
}) {
  return (
    <span
      className={cn(
        'inline-flex flex-none items-center justify-center',
        size === 'sm' ? 'size-7 rounded-lg' : 'size-8 rounded-[10px]',
        tintClass[tint],
      )}
    >
      <IconC size={size === 'sm' ? 14 : 16} aria-hidden="true" />
    </span>
  )
}

/** Uppercase section label with its icon ("MONEY", "OPERATIONS"). */
export function SectionTitle({ icon: IconC, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className={cn(sectionTitle, 'flex items-center gap-2')}>
      <span className="bg-primary inline-flex size-6 items-center justify-center rounded-md text-white">
        <IconC size={13} strokeWidth={2.5} aria-hidden="true" />
      </span>
      {children}
      <span
        aria-hidden="true"
        className="from-primary/40 h-px flex-1 bg-linear-to-r to-transparent"
      />
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
  tint?: Tint
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
      className={cn(card, 'anim-enter border-t-[3px]', tintBorder[tint], className)}
      style={
        {
          '--i': i,
          backgroundImage: `linear-gradient(180deg, ${tintWash[tint]} 0, var(--mmc-card) 88px)`,
        } as CSSProperties
      }
    >
      <h3 className="m-0 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[16px] font-bold">
        <span className="flex min-w-0 flex-[1_1_180px] items-center gap-2.5">
          {icon && <IconChip icon={icon} tint={tint} />}
          <span className={cn('min-w-0 break-words', tintText[tint])}>{title}</span>
        </span>
        {(right || to) && (
          <span className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-x-2 gap-y-1">
            {right && <span className="text-ink-3 text-[13px] font-semibold">{right}</span>}
            {to && <DetailsLink to={to} label={toLabel} title={title} />}
          </span>
        )}
      </h3>
      {children}
    </section>
  )
}

export function Pill({
  tint,
  icon,
  children,
}: {
  tint: Tint
  /** Small symbol before the text (clock for a time, siren for red). */
  icon?: LucideIcon
  children: ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex min-w-6 flex-none items-center justify-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-bold whitespace-nowrap',
        tintClass[tint],
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
    tint?: Tint
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
              'border-grid anim-enter flex min-h-10 items-center gap-2.5 border-b py-1.5 text-[14px] last:border-b-0'
            const style = { '--i': i } as CSSProperties
            const content = (
              <>
                {r.icon && <IconChip icon={r.icon} tint={r.tint} size="sm" />}
                {r.pill}
                {/* the whole label wraps (a medicine with its strength, a full name) */}
                <span className="min-w-0 flex-1 wrap-break-word">{r.label}</span>
                <span className="font-bold whitespace-nowrap tabular-nums">{r.value}</span>
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
                  'group hover:bg-hover focus-visible:ring-primary/45 -mx-1.5 rounded-md px-1.5 text-inherit no-underline outline-none focus-visible:ring-[3px]',
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
    <p className="text-ink-3 m-0 flex items-center gap-2 py-2 text-[14px]">
      {createElement(icon, { size: 18, className: 'text-green flex-none', 'aria-hidden': true })}
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
