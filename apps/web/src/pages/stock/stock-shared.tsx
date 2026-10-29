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
import { formatRwf } from '@mmc/shared'
import { packSizeOf, saleModeOf, sellValueOf } from '@/lib/pack-pricing'
import {
  daysUntil,
  draftLine,
  draftNotWhole,
  draftPieces,
  expiryState,
  packCountText,
  packWord,
  piecesAndPacks,
  tx,
  unitsText,
  wholePacksText,
  type DraftLine,
  type ItemStatus,
  type LineItem,
  type Msg,
  type QtyMode,
} from './stock-util'

/** Small pieces the stock screens share: the message under a form, expiry marks, note lines. */

/**
 * Pieces or packs: the small toggle beside a quantity field (0102). The quantity typed is read
 * in the chosen unit; packs × pieces per pack are the pieces the database takes. A medicine sold
 * only by the whole pack (0107, `packsOnly`) is typed in packs only.
 */
export function QtyModeToggle({
  mode,
  onChange,
  disabled,
  className,
  packsOnly = false,
}: {
  mode: QtyMode
  onChange: (mode: QtyMode) => void
  disabled?: boolean
  className?: string
  packsOnly?: boolean
}) {
  const { t } = useTranslation()
  const modes: QtyMode[] = packsOnly ? ['packs'] : ['pieces', 'packs']
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
            'disabled:text-ink-3 h-7 rounded px-2 text-[12px] font-medium transition-colors duration-120 disabled:cursor-not-allowed',
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
 * line, "Add a line", "Remove". `available` shows what can be sent from where it comes. With
 * `itemOf` (0107) each line is typed in packs or pieces as the medicine is packed ("4 boxes of 8"
 * shows "= 32 tablets" live, and its value at selling price); a medicine sold only by the whole
 * pack is typed in packs, unless the pharmacy splits a pack (`canSplit`) or loose pieces may come
 * back (`piecesOk`, a return).
 */
export function LinesEditor({
  lines,
  onChange,
  options,
  available,
  availableKey = 'stockShared.availableShort',
  itemOf,
  canSplit = false,
  piecesOk = false,
}: {
  lines: DraftLine[]
  onChange: (lines: DraftLine[]) => void
  options: readonly SearchOption[]
  /** Units that can be sent of a medicine (null: not shown). */
  available?: (itemId: string) => number | null
  availableKey?: string
  itemOf?: (itemId: string) => LineItem | null | undefined
  canSplit?: boolean
  piecesOk?: boolean
}) {
  const { t } = useTranslation()
  const set = (key: number, patch: Partial<DraftLine>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  /** How a medicine chosen on a line is typed first: in packs when it has packs. */
  const firstMode = (id: string): QtyMode => (packSizeOf(itemOf?.(id)) ? 'packs' : 'pieces')
  return (
    <div className="@container flex flex-col gap-2">
      {lines.map((l, n) => {
        const avail = l.itemId && available ? available(l.itemId) : null
        const item = l.itemId ? itemOf?.(l.itemId) : undefined
        const size = packSizeOf(item)
        const only = !!size && saleModeOf(item) === 'pack' && !piecesOk && !l.split
        const mode: QtyMode = only ? 'packs' : size ? (l.mode ?? 'pieces') : 'pieces'
        const line = { ...l, mode }
        const pieces = draftPieces(line, item)
        const over = avail != null && pieces > avail
        const notWhole = draftNotWhole(line, item, piecesOk)
        const word = packWord(t, item?.packUnit)
        return (
          <div
            key={l.key}
            className={cn(
              card,
              // narrow (a phone, a side panel): the item takes the whole row, quantity and bin under it
              'grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 p-2 @md:grid-cols-[minmax(0,1fr)_auto_auto]',
            )}
          >
            <SearchSelect
              wrapperClassName="col-span-2 @md:col-span-1"
              label={t('stockShared.lineN', { n: n + 1 })}
              value={l.itemId}
              onChange={(v) => set(l.key, { itemId: v, mode: firstMode(v), split: false })}
              emptyLabel={t('visit.add.pickItem')}
              options={options}
            />
            <span className="flex items-end gap-1.5">
              <Field
                label={
                  mode === 'packs' && size
                    ? tx(t, 'packaging.qtyPacks', 'Quantity · {{pack}} of {{size}}', {
                        pack: word,
                        size,
                      })
                    : t('stock.quantity')
                }
                inputMode="numeric"
                value={l.quantity}
                onChange={(e) => set(l.key, { quantity: e.target.value.replace(/[^\d]/g, '') })}
                className={over || notWhole ? 'border-red' : undefined}
                wrapperClassName="w-24 @md:w-[150px]"
              />
              {size && (
                <QtyModeToggle
                  mode={mode}
                  packsOnly={only}
                  className="mb-0.5"
                  onChange={(m) => set(l.key, { mode: m })}
                />
              )}
            </span>
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
            {(avail != null || pieces > 0 || (canSplit && size && saleModeOf(item) === 'pack')) && (
              <p
                className={cn(
                  'col-span-2 m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] @md:col-span-3',
                  over || notWhole ? 'text-red font-semibold' : 'text-ink-3',
                )}
              >
                {avail != null && (
                  <span>
                    {t(availableKey, { count: avail })}
                    {size ? ` · ${piecesAndPacks(t, avail, item)}` : ''}
                  </span>
                )}
                {pieces > 0 && !notWhole && (
                  <span className="text-ink-2 font-medium tabular-nums">
                    {[
                      mode === 'packs' && size
                        ? `${packCountText(t, Number(l.quantity), size, item?.packUnit)} = ${unitsText(pieces, item?.unit)}`
                        : piecesAndPacks(t, pieces, item),
                      item && (item.sellingPrice != null || item.packPrice != null)
                        ? tx(t, 'packaging.atSellingPrice', 'value at selling price {{value}}', {
                            value: formatRwf(Math.round(sellValueOf(item, pieces))),
                          })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                )}
                {notWhole && item && <span>{wholePacksText(t, pieces, item)}</span>}
                {canSplit && size && saleModeOf(item) === 'pack' && !piecesOk && (
                  <label className="text-ink-2 inline-flex items-center gap-1.5 font-normal">
                    <input
                      type="checkbox"
                      checked={!!l.split}
                      onChange={(e) =>
                        set(l.key, {
                          split: e.target.checked,
                          // split: the pieces typed; back to whole packs: packs
                          mode: e.target.checked ? 'pieces' : 'packs',
                          quantity: e.target.checked
                            ? String(pieces || '')
                            : String(Math.max(1, Math.floor(pieces / size)) || ''),
                        })
                      }
                    />
                    {tx(
                      t,
                      'packaging.splitPack',
                      'Split a {{pack}} (send loose pieces: the pharmacy only)',
                      { pack: word },
                    )}
                  </label>
                )}
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
