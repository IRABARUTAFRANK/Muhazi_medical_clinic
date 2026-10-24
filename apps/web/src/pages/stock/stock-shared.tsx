import { Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Flash } from '@/components/ui/flash'
import { SearchSelect, type SearchOption } from '@/components/ui/search-select'
import { daysUntil, draftLine, expiryState, type DraftLine, type Msg } from './stock-util'

/** Small pieces the stock screens share: the message under a form, expiry marks, note lines. */

/** A flash under a form (success or error), closed by hand. */
export function MsgFlash({ msg, onClose }: { msg: Msg | null; onClose: () => void }) {
  if (!msg) return null
  return (
    <Flash key={msg.text} tone={msg.ok ? 'success' : 'error'} onClose={onClose}>
      {msg.text}
    </Flash>
  )
}

/** The expiry date with a mark: red when expired, amber within 90 days. */
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
      {s === 'expired' && <Badge tone="red">{t('stockShared.expired')}</Badge>}
      {s === 'soon' && (
        <Badge tone="orange">{t('stockShared.expiresIn', { count: daysUntil(date) })}</Badge>
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
    <div className="flex flex-col gap-2">
      {lines.map((l, n) => {
        const avail = l.itemId && available ? available(l.itemId) : null
        const over = avail != null && Number(l.quantity) > avail
        return (
          <div
            key={l.key}
            className="border-border grid grid-cols-[minmax(0,1fr)_110px_auto] items-end gap-2 rounded-xl border p-2 sm:grid-cols-[minmax(0,1fr)_140px_auto]"
          >
            <SearchSelect
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
                className={`col-span-3 m-0 text-[12px] ${over ? 'text-red font-semibold' : 'text-ink-3'}`}
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
