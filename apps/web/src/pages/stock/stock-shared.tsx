import { AlertTriangle, CheckCircle2, Clock, Gauge, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate } from '@mmc/shared'
import { card } from '@/components/dash/kit-style'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Flash } from '@/components/ui/flash'
import { SearchSelect, type SearchOption } from '@/components/ui/search-select'
import { cn } from '@/lib/utils'
import { EXPIRY_WINDOW_DAYS } from '@/lib/api/pharmacy'
import {
  daysUntil,
  draftLine,
  expiryState,
  tx,
  type DraftLine,
  type ItemStatus,
  type Msg,
  type QtyMode,
} from './stock-util'

/** Small pieces the stock screens share: the message under a form, expiry marks, note lines. */

/**
 * Pieces or packs: the small toggle beside a quantity field (0102). The quantity typed is read
 * in the chosen unit; packs × pieces per pack are the pieces the database takes.
 */
export function QtyModeToggle({
  mode,
  onChange,
  disabled,
  className,
}: {
  mode: QtyMode
  onChange: (mode: QtyMode) => void
  disabled?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const modes: QtyMode[] = ['pieces', 'packs']
  return (
    <span
      role="radiogroup"
      aria-label={tx(t, 'stockShared.packs.countIn', 'Count in')}
      className={cn(
        'border-border bg-surface inline-flex h-8 flex-none items-center gap-0.5 rounded-md border p-0.5',
        className,
      )}
    >
      {modes.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m}
          disabled={disabled}
          onClick={() => onChange(m)}
          className={cn(
            'h-7 rounded px-2 text-[12px] font-medium transition-colors duration-120 disabled:opacity-60',
            mode === m
              ? 'bg-card text-primary border-border border'
              : 'text-ink-2 hover:bg-hover hover:text-ink border border-transparent',
          )}
        >
          {tx(t, `stockShared.packs.${m}`, m === 'pieces' ? 'pieces' : 'packs')}
        </button>
      ))}
    </span>
  )
}

/** A flash under a form (success or error), closed by hand. */
export function MsgFlash({ msg, onClose }: { msg: Msg | null; onClose: () => void }) {
  if (!msg) return null
  return (
    <Flash key={msg.text} tone={msg.ok ? 'success' : 'error'} onClose={onClose}>
      {msg.text}
    </Flash>
  )
}

/** The expiry date with a mark: red when expired, amber within the expiry window (30 days). */
export function ExpiryMark({ date }: { date: string | null | undefined }) {
  const { t } = useTranslation()
  const s = expiryState(date)
  if (!date || !s) return <span className="text-ink-3">—</span>
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span
        className={
          s === 'expired'
            ? 'text-red font-semibold'
            : s === 'soon'
              ? 'text-amber font-semibold'
              : ''
        }
      >
        {formatDate(new Date(date))}
      </span>
      {s === 'expired' && (
        <Badge tone="red" icon={<AlertTriangle size={12} aria-hidden="true" />}>
          {t('stockShared.expired')}
        </Badge>
      )}
      {s === 'soon' && (
        <Badge tone="orange" icon={<Clock size={12} aria-hidden="true" />}>
          {t('stockShared.expiresIn', { count: daysUntil(date) })}
        </Badge>
      )}
    </span>
  )
}

/**
 * The lines of a request, a transfer note or a return note: one medicine and a quantity per
 * line, "Add a line", "Remove". `available` shows what can be sent from where it comes.
 */
export function LinesEditor({
  lines,
  onChange,
  options,
  available,
  availableKey = 'stockShared.availableShort',
}: {
  lines: DraftLine[]
  onChange: (lines: DraftLine[]) => void
  options: readonly SearchOption[]
  /** Units that can be sent of a medicine (null: not shown). */
  available?: (itemId: string) => number | null
  availableKey?: string
}) {
  const { t } = useTranslation()
  const set = (key: number, patch: Partial<DraftLine>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  return (
    <div className="@container flex flex-col gap-2">
      {lines.map((l, n) => {
        const avail = l.itemId && available ? available(l.itemId) : null
        const over = avail != null && Number(l.quantity) > avail
        return (
          <div
            key={l.key}
            className={cn(
              card,
              // narrow (a phone, a side panel): the item takes the whole row, quantity and bin under it
              'grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 p-2 @md:grid-cols-[minmax(0,1fr)_140px_auto]',
            )}
          >
            <SearchSelect
              wrapperClassName="col-span-2 @md:col-span-1"
              label={t('stockShared.lineN', { n: n + 1 })}
              value={l.itemId}
              onChange={(v) => set(l.key, { itemId: v })}
              emptyLabel={t('visit.add.pickItem')}
              options={options}
            />
            <Field
              label={t('stock.quantity')}
              inputMode="numeric"
              value={l.quantity}
              onChange={(e) => set(l.key, { quantity: e.target.value.replace(/[^\d]/g, '') })}
              className={over ? 'border-red' : undefined}
            />
            <Button
              variant="ghost"
              size="icon"
              title={t('stockShared.removeLine')}
              aria-label={t('stockShared.removeLine')}
              disabled={lines.length === 1}
              onClick={() => onChange(lines.filter((x) => x.key !== l.key))}
            >
              <Trash2 size={16} aria-hidden="true" />
            </Button>
            {avail != null && (
              <p
                className={`col-span-2 m-0 text-[12px] @md:col-span-3 ${over ? 'text-red font-semibold' : 'text-ink-3'}`}
              >
                {t(availableKey, { count: avail })}
              </p>
            )}
          </div>
        )
      })}
      <Button size="sm" className="self-start" onClick={() => onChange([...lines, draftLine()])}>
        <Plus size={14} aria-hidden="true" />
        {t('stockShared.addLine')}
      </Button>
    </div>
  )
}

const STATUS_TONE: Record<ItemStatus, 'red' | 'yellow' | 'orange'> = {
  expired: 'red',
  expiring: 'yellow',
  low: 'orange',
}
const STATUS_ICON: Record<ItemStatus, typeof Clock> = {
  expired: AlertTriangle,
  expiring: Clock,
  low: Gauge,
}

/** The status tags of an item (none: OK). */
export function StatusTags({ statuses }: { statuses: ItemStatus[] }) {
  const { t } = useTranslation()
  if (statuses.length === 0)
    return (
      <Badge tone="green" icon={<CheckCircle2 size={12} aria-hidden="true" />}>
        {t('stockPage.status.ok')}
      </Badge>
    )
  return (
    <span className="flex flex-wrap gap-1">
      {statuses.map((s) => {
        const Icon = STATUS_ICON[s]
        return (
          <Badge key={s} tone={STATUS_TONE[s]} icon={<Icon size={12} aria-hidden="true" />}>
            {t(`stockPage.status.${s}`, { count: EXPIRY_WINDOW_DAYS })}
          </Badge>
        )
      })}
    </span>
  )
}
