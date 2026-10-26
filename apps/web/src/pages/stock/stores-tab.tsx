import { useState, type FormEvent } from 'react'
import { ArrowRightLeft, Boxes, Plus, Star, Store } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatNumber } from '@mmc/shared'
import { Panel } from '@/components/dash/kit'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { SearchSelect } from '@/components/ui/search-select'
import { useStockActions, type StockItem, type StockLocation } from '@/lib/api/stock'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import { MsgFlash } from './stock-shared'
import {
  errText,
  itemName,
  mainPharmacy,
  pharmacySide,
  roomStores,
  usableIn,
  type Msg,
} from './stock-util'

/**
 * The pharmacy's stores. The pharmacy is the main store: every delivery is received there (the
 * main pharmacy store when there are several). The old main store keeps its stock and history:
 * its stock is sent to the pharmacy, then it can be closed. Closed stores can be opened again.
 * Room stores are managed under "Room stores".
 */
export function StoresTab({
  locations,
  items,
  mainId,
  isManager,
}: {
  locations: StockLocation[]
  items: StockItem[]
  mainId: string | null
  isManager: boolean
}) {
  const { t } = useTranslation()
  const actions = useStockActions()
  const confirm = useConfirm()
  const [msg, setMsg] = useState<Msg | null>(null)
  const [name, setName] = useState('')
  const stores = pharmacySide(locations, true).sort(
    (a, b) =>
      Number(a.active === false) - Number(b.active === false) ||
      Number(!!b.isMain) - Number(!!a.isMain),
  )
  const main = mainPharmacy(locations, mainId)
  const unitsIn = (id: string) => items.reduce((s, i) => s + (i.byLocation[id] ?? 0), 0)

  const setActive = async (l: StockLocation) => {
    const closing = l.active !== false
    setMsg(null)
    if (closing && unitsIn(l.id) > 0)
      return setMsg({ ok: false, text: t('stockStores.notEmpty', { name: l.name }) })
    if (
      !(await confirm({
        title: t(closing ? 'confirm.stock.closeStoreTitle' : 'confirm.stock.openStoreTitle', {
          name: l.name,
        }),
        body: closing ? t('confirm.stock.closeStoreBody') : undefined,
        confirmLabel: t(closing ? 'confirm.stock.closeStoreYes' : 'confirm.stock.openStoreYes'),
        tone: closing ? 'danger' : 'primary',
      }))
    )
      return
    try {
      await actions.setLocationActive.mutateAsync({ id: l.id, active: !closing })
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    }
  }
  const makeMain = async (l: StockLocation) => {
    setMsg(null)
    if (
      !(await confirm({
        title: t('confirm.stores.mainTitle', { name: l.name }),
        body: t('confirm.stores.mainBody'),
        confirmLabel: t('confirm.stores.mainYes'),
      }))
    )
      return
    try {
      await actions.setMainPharmacy.mutateAsync(l.id)
      setMsg({ ok: true, text: t('stockStores.mainSaved', { name: l.name }) })
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    }
  }
  // the old main store's stock goes to the pharmacy, medicine by medicine, in one confirmation
  const emptyToPharmacy = async (l: StockLocation) => {
    setMsg(null)
    if (!main) return setMsg({ ok: false, text: t('stockStores.noPharmacy') })
    const toMove = items.map((i) => ({ i, q: usableIn(i, l.id) })).filter((x) => x.q > 0)
    const expired = items.reduce(
      (s, i) => s + Math.max(0, (i.byLocation[l.id] ?? 0) - usableIn(i, l.id)),
      0,
    )
    if (toMove.length === 0)
      return setMsg({
        ok: false,
        text:
          expired > 0 ? t('stockStores.onlyExpired', { count: expired }) : t('stockStores.nothing'),
      })
    if (
      !(await confirm({
        title: t('confirm.stores.emptyTitle', { from: l.name, to: main.name }),
        body: t('confirm.stores.emptyBody', {
          count: toMove.length,
          units: formatNumber(toMove.reduce((s, x) => s + x.q, 0)),
        }),
        confirmLabel: t('confirm.stores.emptyYes'),
      }))
    )
      return
    let done = 0
    try {
      for (const x of toMove) {
        await actions.transfer.mutateAsync({
          itemId: x.i.id,
          from: l.id,
          to: main.id,
          quantity: x.q,
          reason: t('stockStores.emptyReason'),
        })
        done++
      }
      setMsg({
        ok: true,
        text: [
          t('stockStores.emptied', { count: done, to: main.name }),
          expired > 0 ? t('stockStores.expiredLeft', { count: expired }) : '',
        ]
          .filter(Boolean)
          .join(' '),
      })
    } catch (e) {
      setMsg({
        ok: false,
        text: t('stockStores.emptyPartial', { count: done, error: errText(e) }),
      })
    }
  }
  const add = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    if (name.trim().length < 2) return setMsg({ ok: false, text: t('stock.errors.storeName') })
    if (
      !(await confirm({
        title: t('confirm.stock.addStoreTitle', { name: name.trim() }),
        body: t('confirm.stores.addBody'),
        confirmLabel: t('confirm.stock.addStoreYes'),
      }))
    )
      return
    try {
      await actions.saveLocation.mutateAsync({ name, type: 'pharmacy', departmentId: null })
      setMsg({ ok: true, text: t('stock.storeSaved', { name: name.trim() }) })
      setName('')
    } catch (err) {
      setMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <Panel i={1} icon={Store} tint="amber" title={t('stock.storesTitle')}>
      <p className="text-ink-2 m-0 text-[14px]">{t('stockStores.lead')}</p>
      <div className="flex flex-col gap-2">
        {stores.map((l) => {
          const units = unitsIn(l.id)
          const closed = l.active === false
          const isMain = l.type === 'pharmacy' && main?.id === l.id
          return (
            <div
              key={l.id}
              className={cn(
                'border-border flex flex-wrap items-center gap-3 rounded-md border p-3',
                closed && 'opacity-75',
              )}
            >
              <Store size={18} aria-hidden="true" className="text-ink-3" />
              <span className="min-w-[200px] flex-1">
                <span className={cn('block font-semibold', closed && 'text-ink-3 line-through')}>
                  {l.name}
                </span>
                <span className="text-ink-3 block text-[12px]">
                  {t(`stock.storeTypes.${l.type}`)} · {t('roomStores.unitsCount', { count: units })}
                  {l.type === 'main_store' && !closed ? ` · ${t('stockStores.oldMainHint')}` : ''}
                </span>
              </span>
              {isMain && (
                <Badge tone="green" icon={<Star size={12} aria-hidden="true" />}>
                  {t('stockStores.main')}
                </Badge>
              )}
              {closed && <Badge tone="grey">{t('stockStores.closed')}</Badge>}
              <span className="flex flex-wrap gap-1.5">
                {!closed && l.type === 'pharmacy' && !isMain && isManager && (
                  <Button size="sm" onClick={() => void makeMain(l)}>
                    <Star size={14} aria-hidden="true" />
                    {t('stockStores.makeMain')}
                  </Button>
                )}
                {!closed && l.type === 'main_store' && units > 0 && (
                  <Button
                    size="sm"
                    variant="primary"
                    loading={actions.transfer.isPending}
                    onClick={() => void emptyToPharmacy(l)}
                  >
                    <ArrowRightLeft size={14} aria-hidden="true" />
                    {t('stockStores.sendToPharmacy')}
                  </Button>
                )}
                {!isMain && (
                  <Button
                    size="sm"
                    variant={closed ? 'default' : 'danger'}
                    onClick={() => void setActive(l)}
                  >
                    {closed ? t('stock.storeOpen') : t('stock.storeClose')}
                  </Button>
                )}
              </span>
            </div>
          )
        })}
      </div>
      <p className="text-ink-3 m-0 text-[12px]">
        {t('stockStores.roomsElsewhere', { count: roomStores(locations, true).length })}
      </p>
      <form
        onSubmit={(e) => void add(e)}
        className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
      >
        <Field
          label={t('stockStores.newPharmacy')}
          value={name}
          placeholder={t('stockStores.newPharmacyPh')}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" variant="primary" loading={actions.saveLocation.isPending}>
          <Plus size={16} aria-hidden="true" />
          {t('stock.addStore')}
        </Button>
      </form>
      <MsgFlash msg={msg} onClose={() => setMsg(null)} />
    </Panel>
  )
}

/** The shelf of a pharmacy store was counted: the stock becomes the count, with the reason. */
export function PharmacyCountForm({
  items,
  locations,
}: {
  items: StockItem[]
  locations: StockLocation[]
}) {
  const { t } = useTranslation()
  const actions = useStockActions()
  const confirm = useConfirm()
  const stores = pharmacySide(locations)
  const [itemId, setItemId] = useState('')
  const [chosen, setLocationId] = useState('')
  const locationId = chosen || (stores.find((l) => l.isMain)?.id ?? stores[0]?.id ?? '')
  const [counted, setCounted] = useState('')
  const [reason, setReason] = useState('')
  const [msg, setMsg] = useState<Msg | null>(null)
  const item = items.find((i) => i.id === itemId)
  const current = item ? (item.byLocation[locationId] ?? 0) : 0
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    const n = Number(counted)
    if (!itemId) return setMsg({ ok: false, text: t('stock.errors.item') })
    if (!locationId) return setMsg({ ok: false, text: t('stock.errors.store') })
    if (counted === '' || !Number.isInteger(n) || n < 0)
      return setMsg({ ok: false, text: t('stock.reorderBad') })
    if (reason.trim().length < 3) return setMsg({ ok: false, text: t('stock.errors.countWhy') })
    if (
      !(await confirm({
        title: t('confirm.stock.countTitle', {
          item: itemName(item),
          store: stores.find((l) => l.id === locationId)?.name ?? '',
          after: n,
        }),
        body: t('confirm.stock.countBody', { before: current, after: n }),
        confirmLabel: t('confirm.stock.countYes'),
        tone: n < current ? 'danger' : 'primary',
      }))
    )
      return
    try {
      await actions.adjust.mutateAsync({ itemId, locationId, counted: n, reason: reason.trim() })
      setMsg({
        ok: true,
        text: t('stock.countSaved', { item: itemName(item), before: current, after: n }),
      })
      setCounted('')
      setReason('')
    } catch (err) {
      setMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <Panel i={2} icon={Boxes} tint="teal" title={t('stock.countTitle')}>
      <p className="text-ink-2 m-0 text-[14px]">{t('stockStores.countLead')}</p>
      <form
        onSubmit={(e) => void submit(e)}
        className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_120px]"
      >
        <SearchSelect
          label={t('stock.cols.item')}
          value={itemId}
          onChange={setItemId}
          emptyLabel={t('visit.add.pickItem')}
          options={items.filter((i) => i.active).map((i) => ({ value: i.id, label: itemName(i) }))}
        />
        <Select
          label={t('stock.store')}
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
        >
          {stores.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
        <Field
          label={t('stock.counted')}
          inputMode="numeric"
          value={counted}
          placeholder={String(current)}
          onChange={(e) => setCounted(e.target.value.replace(/[^\d]/g, ''))}
        />
        <Field
          label={t('stock.countWhy')}
          value={reason}
          placeholder={t('stock.countWhyPh')}
          onChange={(e) => setReason(e.target.value)}
          wrapperClassName="sm:col-span-2"
        />
        <Button type="submit" variant="primary" loading={actions.adjust.isPending}>
          {t('stock.countSave')}
        </Button>
      </form>
      {item && (
        <p className="text-ink-3 m-0 text-[13px]">{t('stock.countNow', { count: current })}</p>
      )}
      <MsgFlash msg={msg} onClose={() => setMsg(null)} />
    </Panel>
  )
}
