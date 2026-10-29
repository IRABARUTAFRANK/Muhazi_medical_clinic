import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowRightLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Panel } from '@/components/dash/kit'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { SearchSelect } from '@/components/ui/search-select'
import { useStockActions, type StockOverview } from '@/lib/api/stock'
import { useConfirm } from '@/lib/confirm'
import { MsgFlash, QtyModeToggle } from './stock-shared'
import { packSizeOf } from '@/lib/pack-pricing'
import {
  errText,
  itemName,
  packCountText,
  piecesAndPacks,
  unitsText,
  type QtyMode,
  mainPharmacy,
  pharmacySide,
  pharmacyStores,
  roomStores,
  usableIn,
  type Msg,
} from './stock-util'

/**
 * Stock moved between the pharmacy's own stores, or from the old main store to the pharmacy
 * (shown only when the pharmacy has more than one store). Room stores are supplied on transfer
 * notes above, and return their stock the same way.
 */
export function BetweenStoresForm({
  overview,
  preset,
  focused,
}: {
  overview: StockOverview | undefined
  /** The medicine and the store to send to (e.g. the pharmacy desk, short of it). */
  preset?: { item?: string; to?: string }
  /** Opened from the desk or an older address: scrolled into view. */
  focused?: boolean
}) {
  const { t } = useTranslation()
  const actions = useStockActions()
  const confirm = useConfirm()
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focused) box.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [focused])
  const items = overview?.items ?? []
  const locations = overview?.locations ?? []
  const sources = pharmacySide(locations)
  const targets = pharmacyStores(locations)
  const [itemId, setItemId] = useState(preset?.item ?? '')
  const item = items.find((i) => i.id === itemId)
  const [chosenTo, setTo] = useState('')
  const to =
    chosenTo ||
    (targets.find((l) => l.id === preset?.to)?.id ??
      mainPharmacy(locations, overview?.mainPharmacyId)?.id ??
      '')
  // from the other pharmacy-side store holding the most of it
  const fullest = item
    ? sources
        .filter((l) => l.id !== to && usableIn(item, l.id) > 0)
        .sort((a, b) => usableIn(item, b.id) - usableIn(item, a.id))[0]?.id
    : undefined
  const [chosenFrom, setFrom] = useState('')
  const from = chosenFrom || (fullest ?? sources.find((l) => l.id !== to)?.id ?? '')
  const [quantity, setQuantity] = useState('')
  // 0107: typed in packs or in pieces as the medicine is packed; moved in pieces
  const [mode, setMode] = useState<QtyMode>('pieces')
  const size = packSizeOf(item)
  const typedMode: QtyMode = size ? mode : 'pieces'
  const pieces = (Number(quantity) || 0) * (typedMode === 'packs' && size ? size : 1)
  const [reason, setReason] = useState('')
  const [msg, setMsg] = useState<Msg | null>(null)
  const available = usableIn(item, from)
  // the medicine is only in room stores: they return it on a return note
  const inRooms = item ? roomStores(locations).filter((l) => (item.byLocation[l.id] ?? 0) > 0) : []
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    const q = pieces
    if (!itemId) return setMsg({ ok: false, text: t('stock.errors.item') })
    if (!from || !to || from === to) return setMsg({ ok: false, text: t('stock.errors.store') })
    if (!Number.isInteger(q) || q <= 0)
      return setMsg({ ok: false, text: t('stock.errors.quantity') })
    if (q > available)
      return setMsg({ ok: false, text: t('stock.errors.short', { count: available }) })
    const toName = locations.find((l) => l.id === to)?.name ?? ''
    if (
      !(await confirm({
        title: t('confirm.stock.sendTitle', {
          quantity: q,
          item: itemName(item),
          from: locations.find((l) => l.id === from)?.name ?? '',
          to: toName,
        }),
        confirmLabel: t('confirm.stock.sendYes'),
      }))
    )
      return
    try {
      await actions.transfer.mutateAsync({ itemId, from, to, quantity: q, reason })
      setMsg({ ok: true, text: t('stock.sent', { count: q, item: itemName(item), to: toName }) })
      setQuantity('')
    } catch (err) {
      setMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <div ref={box} className="scroll-mt-4">
      <Panel i={4} icon={ArrowRightLeft} tint="teal" title={t('stockShared.sendTitle')}>
        <p className="text-ink-2 m-0 text-[14px]">{t('stockShared.sendLead')}</p>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <SearchSelect
            label={t('stockPage.cols.item')}
            value={itemId}
            onChange={setItemId}
            required
            emptyLabel={t('stockPage.add.pickItem')}
            options={items
              .filter((i) => i.active && i.onHand > 0)
              .map((i) => ({
                value: i.id,
                label: `${itemName(i)} · ${t('stock.onHandShort', { count: i.onHand })}`,
              }))}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Select
              label={t('stock.fromStore')}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              required
            >
              {sources.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {item ? ` · ${usableIn(item, l.id)}` : ''}
                </option>
              ))}
            </Select>
            <Select
              label={t('stock.toStore')}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              required
            >
              <option value="">{t('stock.pickStore')}</option>
              {targets
                .filter((l) => l.id !== from)
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                    {l.isMain ? ` · ${t('stockStores.main')}` : ''}
                  </option>
                ))}
            </Select>
            <span className="flex items-end gap-1.5">
              <Field
                label={t('stock.quantity')}
                inputMode="numeric"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value.replace(/[^\d]/g, ''))}
                required
                wrapperClassName="min-w-0 flex-1"
              />
              {size && <QtyModeToggle mode={typedMode} onChange={setMode} className="mb-0.5" />}
            </span>
          </div>
          {item && (
            <p className="text-ink-3 m-0 text-[13px]">
              {t('stock.availableHere', { count: available })}
              {size ? ` · ${piecesAndPacks(t, available, item)}` : ''}
              {typedMode === 'packs' && size && pieces > 0 && (
                <span className="text-ink-2 font-medium">
                  {' '}
                  · {packCountText(t, Number(quantity), size, item.packUnit)} ={' '}
                  {unitsText(pieces, item.unit)}
                </span>
              )}
            </p>
          )}
          {item && available === 0 && inRooms.length > 0 && (
            <p className="bg-blue-bg text-blue m-0 rounded-md px-3 py-2 text-[14px]">
              {t('stockShared.onlyInRooms', { stores: inRooms.map((l) => l.name).join(', ') })}
            </p>
          )}
          <Field
            label={t('stock.reason')}
            value={reason}
            placeholder={t('stockShared.sendReasonPh')}
            onChange={(e) => setReason(e.target.value)}
            wrapperClassName="sm:max-w-md"
          />
          <MsgFlash msg={msg} onClose={() => setMsg(null)} />
          <Button
            type="submit"
            variant="primary"
            className="self-start"
            loading={actions.transfer.isPending}
          >
            {!actions.transfer.isPending && <ArrowRightLeft size={16} aria-hidden="true" />}
            {t('stock.send')}
          </Button>
        </form>
      </Panel>
    </div>
  )
}
