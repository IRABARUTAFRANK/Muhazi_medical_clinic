import { useState, type FormEvent } from 'react'
import {
  AlertTriangle,
  ArrowRightLeft,
  Boxes,
  Coins,
  ListOrdered,
  Package,
  PackagePlus,
  Pill,
  Store,
  Warehouse,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  CLINIC_PROFILE,
  formatDate,
  formatNumber,
  formatRwf,
  formatTime,
  isoDate,
  type StaffUser,
} from '@mmc/shared'
import { Empty, Kpi, Panel } from '@/components/dash/kit'
import { BannerChip, PageBanner } from '@/components/dash/page-banner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { ListBar, Pager } from '@/components/ui/list-tools'
import { Select } from '@/components/ui/select'
import { StaffShell } from '@/components/staff/staff-shell'
import {
  usePharmacyQueue,
  useStockActions,
  useStockMovements,
  useStockOverview,
  useStockSales,
  type StockItem,
  type StockLocation,
} from '@/lib/api/stock'
import { useDepartments } from '@/lib/api/staff'
import { useClinicInfo } from '@/lib/api/public'
import { ReportButtons } from '@/components/dash/report-buttons'
import { stockReport } from '@/lib/reports/build'
import { useNow } from '@/lib/hooks'
import { navForUser } from '@/lib/nav'
import { matches, usePaged } from '@/lib/paging'
import { cn } from '@/lib/utils'

type Tab = 'stock' | 'pharmacy' | 'receive' | 'send' | 'moves' | 'sales' | 'stores'
const TABS: { id: Tab; icon: typeof Package }[] = [
  { id: 'stock', icon: Boxes },
  { id: 'pharmacy', icon: Pill },
  { id: 'receive', icon: PackagePlus },
  { id: 'send', icon: ArrowRightLeft },
  { id: 'moves', icon: ListOrdered },
  { id: 'sales', icon: Coins },
  { id: 'stores', icon: Store },
]
const errorBox = 'bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold'
const okBox = 'bg-green-bg text-green m-0 rounded-lg px-3 py-2 text-[13px] font-semibold'
const monthStart = () => {
  const d = new Date()
  return isoDate(new Date(d.getFullYear(), d.getMonth(), 1))
}

/**
 * Medicine stock (pharmacist, manager): what is on hand and where, with cost and selling price
 * and the value of the stock; receiving; sending a quantity to a department or a doctor's
 * office; the pharmacy hand-over queue; the ledger; what was sold and the margin.
 */
export function StockPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('stock')
  const { data, error } = useStockOverview()
  const { data: queue = [] } = usePharmacyQueue()
  const now = useNow(60_000)
  const items = data?.items ?? []
  const { data: info } = useClinicInfo()
  const reportFrom = monthStart()
  const reportTo = isoDate(new Date(now))
  const { data: reportMoves = [] } = useStockMovements(reportFrom, reportTo, null)
  const { data: reportSales } = useStockSales(reportFrom, reportTo)
  const locations = data?.locations ?? []
  const value = items.reduce((s, i) => s + i.costValue, 0)
  const low = items.filter((i) => i.active && i.onHand <= i.reorderLevel).length
  const expiring = items.filter(
    (i) => i.earliestExpiry && new Date(i.earliestExpiry).getTime() < now + 90 * 86_400_000,
  ).length
  const canWrite = ['manager', 'doctor', 'nurse', 'lab_tech'].includes(user.role)

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="stock">
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        <PageBanner
          icon={Warehouse}
          tint="mint"
          title={t('stock.title')}
          lead={t('stock.lead')}
          meta={
            <BannerChip icon={Coins}>
              {t('stock.valueChip', { amount: formatRwf(value) })}
            </BannerChip>
          }
        >
          <ReportButtons
            build={() =>
              stockReport(
                items,
                reportMoves,
                reportSales,
                reportFrom,
                reportTo,
                info?.profile ?? CLINIC_PROFILE,
                user,
                t,
              )
            }
          />
        </PageBanner>
        {error && <p className={errorBox}>{error.message}</p>}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(230px,1fr))] sm:gap-4">
          <Kpi
            i={0}
            icon={Boxes}
            tint="mint"
            label={t('stock.tiles.items')}
            value={items.filter((i) => i.active).length}
            unit={t('stock.units.items')}
          />
          <Kpi
            i={1}
            icon={Coins}
            tint="navy"
            label={t('stock.tiles.value')}
            value={value}
            unit="RWF"
          />
          <Kpi
            i={2}
            icon={AlertTriangle}
            tint="amber"
            label={t('stock.tiles.low')}
            value={low}
            unit={t('stock.units.toReorder')}
            delta={low > 0 ? { text: t('stock.reorderSoon'), good: false, up: null } : undefined}
          />
          <Kpi
            i={3}
            icon={AlertTriangle}
            tint="coral"
            label={t('stock.tiles.expiring')}
            value={expiring}
            unit={t('stock.units.in90')}
          />
          <Kpi
            i={4}
            icon={Pill}
            tint="violet"
            label={t('stock.tiles.pharmacy')}
            value={queue.length}
            unit={t('stock.units.toHandOver')}
          />
        </div>

        <div className="flex flex-wrap gap-1 self-start rounded-xl bg-white/70 p-1" role="tablist">
          {TABS.map((x) => (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={tab === x.id}
              onClick={() => setTab(x.id)}
              className={cn(
                'inline-flex min-h-10 items-center gap-2 rounded-lg px-3.5 text-[14px] font-semibold whitespace-nowrap',
                tab === x.id ? 'bg-navy text-white' : 'text-ink-2 hover:bg-hover',
              )}
            >
              <x.icon size={16} aria-hidden="true" />
              {t(`stock.tabs.${x.id}`)}
              {x.id === 'pharmacy' && queue.length > 0 && (
                <span
                  className={cn(
                    'rounded-full px-1.5 text-[12px]',
                    tab === x.id ? 'bg-white/20' : 'bg-amber-bg text-amber',
                  )}
                >
                  {queue.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {tab === 'stock' && <StockTable items={items} locations={locations} />}
        {tab === 'pharmacy' && <PharmacyDesk canDispense={canWrite} />}
        {tab === 'receive' && <ReceiveForm items={items} locations={locations} />}
        {tab === 'send' && <SendForm items={items} locations={locations} />}
        {tab === 'moves' && <Movements items={items} />}
        {tab === 'sales' && <Sales />}
        {tab === 'stores' && <Stores locations={locations} />}
      </main>
    </StaffShell>
  )
}

/* ---------------------------------------------------------------- on hand */
function StockTable({ items, locations }: { items: StockItem[]; locations: StockLocation[] }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const now = useNow(60_000)
  const shown = items.filter((i) => i.active && matches(query, i.name, i.strength ?? '', i.code))
  const paged = usePaged(shown, 20, query)
  return (
    <Panel
      i={1}
      icon={Boxes}
      tint="mint"
      title={t('stock.onHand')}
      right={t('stock.itemCount', { count: shown.length })}
    >
      <ListBar query={query} onQuery={setQuery} placeholderKey="stock.search" />
      {paged.total === 0 ? (
        <Empty icon={Package}>{t('stock.empty')}</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="text-ink-3 text-left text-[11px] tracking-[.04em] uppercase">
                <th className="border-border border-b py-2 pr-2 font-semibold">
                  {t('stock.cols.item')}
                </th>
                <th className="border-border border-b py-2 pr-2 text-right font-semibold">
                  {t('stock.cols.onHand')}
                </th>
                {locations.map((l) => (
                  <th
                    key={l.id}
                    className="border-border hidden border-b py-2 pr-2 text-right font-semibold lg:table-cell"
                  >
                    {l.name}
                  </th>
                ))}
                <th className="border-border hidden border-b py-2 pr-2 text-right font-semibold sm:table-cell">
                  {t('stock.cols.cost')}
                </th>
                <th className="border-border border-b py-2 pr-2 text-right font-semibold">
                  {t('stock.cols.price')}
                </th>
                <th className="border-border hidden border-b py-2 pr-2 text-right font-semibold md:table-cell">
                  {t('stock.cols.value')}
                </th>
                <th className="border-border hidden border-b py-2 font-semibold md:table-cell">
                  {t('stock.cols.expiry')}
                </th>
              </tr>
            </thead>
            <tbody>
              {paged.slice.map((i) => {
                const lowStock = i.onHand <= i.reorderLevel
                const soon =
                  i.earliestExpiry && new Date(i.earliestExpiry).getTime() < now + 90 * 86_400_000
                return (
                  <tr key={i.id} className="border-grid border-b last:border-b-0">
                    <td className="py-2 pr-2">
                      <span className="block font-semibold">
                        {i.name}
                        {i.strength ? ` ${i.strength}` : ''}
                      </span>
                      <span className="text-ink-3 text-[12px]">
                        {i.code}
                        {i.unit ? ` · ${t('prices.meds.perUnit', { unit: i.unit })}` : ''}
                        {' · '}
                        {t('stock.reorderAt', { count: i.reorderLevel })}
                      </span>
                    </td>
                    <td
                      className={cn(
                        'py-2 pr-2 text-right font-bold tabular-nums',
                        lowStock ? 'text-red' : i.onHand === 0 ? 'text-ink-3' : 'text-green',
                      )}
                    >
                      {formatNumber(i.onHand)}
                      {lowStock && (
                        <Badge tone="red" className="ml-1.5">
                          {t('stock.low')}
                        </Badge>
                      )}
                    </td>
                    {locations.map((l) => (
                      <td
                        key={l.id}
                        className="text-ink-2 hidden py-2 pr-2 text-right tabular-nums lg:table-cell"
                      >
                        {i.byLocation[l.id] ? formatNumber(i.byLocation[l.id]!) : '—'}
                      </td>
                    ))}
                    <td className="hidden py-2 pr-2 text-right tabular-nums sm:table-cell">
                      {i.avgCost == null ? '—' : formatNumber(i.avgCost)}
                    </td>
                    <td className="py-2 pr-2 text-right font-semibold tabular-nums">
                      {i.sellingPrice == null ? t('prices.noPrice') : formatNumber(i.sellingPrice)}
                    </td>
                    <td className="hidden py-2 pr-2 text-right tabular-nums md:table-cell">
                      {formatNumber(Math.round(i.costValue))}
                    </td>
                    <td
                      className={cn(
                        'hidden py-2 tabular-nums md:table-cell',
                        soon && 'text-amber font-semibold',
                        i.expiredUnits > 0 && 'text-red',
                      )}
                    >
                      {i.earliestExpiry ? formatDate(new Date(i.earliestExpiry)) : '—'}
                      {i.expiredUnits > 0 && ` · ${t('stock.expired', { count: i.expiredUnits })}`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager {...paged} onPage={paged.setPage} />
    </Panel>
  )
}

/* ---------------------------------------------------------------- pharmacy hand-over */
function PharmacyDesk({ canDispense }: { canDispense: boolean }) {
  const { t } = useTranslation()
  const { data: queue = [] } = usePharmacyQueue()
  const actions = useStockActions()
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const give = async (requestId: string, patient: string, item: string) => {
    setMsg(null)
    try {
      const r = await actions.dispense.mutateAsync(requestId)
      setMsg({
        ok: true,
        text: t(r.charged ? 'stock.dispensedCharged' : 'stock.dispensedNoPrice', { patient, item }),
      })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    }
  }
  return (
    <Panel
      i={1}
      icon={Pill}
      tint="violet"
      title={t('stock.pharmacyTitle')}
      right={t('stock.toHandOver', { count: queue.length })}
    >
      {msg && <p className={msg.ok ? okBox : errorBox}>{msg.text}</p>}
      {queue.length === 0 ? (
        <Empty>{t('stock.pharmacyEmpty')}</Empty>
      ) : (
        <div className="flex flex-col">
          {queue.map((q) => {
            const short = q.onHandPharmacy < q.quantity
            return (
              <div
                key={q.requestId}
                className="border-grid flex flex-wrap items-center gap-3 border-b py-2.5 last:border-b-0"
              >
                <Badge tone="blue">{q.ticket ?? '—'}</Badge>
                <span className="min-w-[200px] flex-1">
                  <span className="block font-semibold">
                    {q.patient} <span className="text-ink-3 font-normal">· {q.file}</span>
                  </span>
                  <span className="text-ink block text-[13px]">
                    <b>{q.item}</b> × {q.quantity}
                    {q.unit ? ` ${q.unit}` : ''}
                    {q.dose ? ` · ${q.dose}` : ''}
                    {q.frequency ? ` · ${q.frequency}` : ''}
                    {q.days ? ` · ${t('history.days', { count: q.days })}` : ''}
                  </span>
                  <span className="text-ink-3 block text-[12px]">
                    {[q.prescriber, formatTime(new Date(q.at)), q.instructions]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <span className="text-right text-[13px]">
                  <span className="block font-bold tabular-nums">
                    {q.price == null ? t('prices.noPrice') : formatRwf(q.price * q.quantity)}
                  </span>
                  <span
                    className={cn(
                      'block text-[12px]',
                      short ? 'text-red font-semibold' : 'text-ink-3',
                    )}
                  >
                    {t('stock.inPharmacy', { count: q.onHandPharmacy })}
                  </span>
                </span>
                {canDispense && (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={short}
                    loading={
                      actions.dispense.isPending && actions.dispense.variables === q.requestId
                    }
                    onClick={() => void give(q.requestId, q.patient, q.item)}
                  >
                    <Pill size={14} aria-hidden="true" />
                    {t('stock.handOver')}
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      )}
      <p className="text-ink-3 m-0 text-[13px]">{t('stock.pharmacyHint')}</p>
    </Panel>
  )
}

/* ---------------------------------------------------------------- receiving */
function ReceiveForm({ items, locations }: { items: StockItem[]; locations: StockLocation[] }) {
  const { t } = useTranslation()
  const actions = useStockActions()
  const [itemId, setItemId] = useState('')
  const [locationId, setLocationId] = useState(
    locations.find((l) => l.type === 'main_store')?.id ?? locations[0]?.id ?? '',
  )
  const [quantity, setQuantity] = useState('')
  const [unitCost, setUnitCost] = useState('')
  const [batchNo, setBatchNo] = useState('')
  const [expiry, setExpiry] = useState('')
  const [supplier, setSupplier] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const item = items.find((i) => i.id === itemId)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    const q = Number(quantity)
    const c = Number(unitCost)
    if (!itemId) return setMsg({ ok: false, text: t('stock.errors.item') })
    if (!locationId) return setMsg({ ok: false, text: t('stock.errors.store') })
    if (!Number.isFinite(q) || q <= 0)
      return setMsg({ ok: false, text: t('stock.errors.quantity') })
    if (!Number.isFinite(c) || c < 0 || unitCost === '')
      return setMsg({ ok: false, text: t('stock.errors.cost') })
    try {
      await actions.receive.mutateAsync({
        itemId,
        locationId,
        quantity: q,
        unitCost: c,
        batchNo,
        expiry,
        supplier,
      })
      setMsg({
        ok: true,
        text: t('stock.received', { count: q, item: item?.name ?? '', value: formatRwf(q * c) }),
      })
      setQuantity('')
      setBatchNo('')
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    }
  }
  return (
    <Panel i={1} icon={PackagePlus} tint="mint" title={t('stock.receiveTitle')}>
      <p className="text-ink-2 m-0 text-[13px]">{t('stock.receiveLead')}</p>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select
            label={t('stock.cols.item')}
            value={itemId}
            onChange={(e) => setItemId(e.target.value)}
            required
          >
            <option value="">{t('visit.add.pickItem')}</option>
            {items
              .filter((i) => i.active)
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                  {i.strength ? ` ${i.strength}` : ''}
                  {i.unit ? ` (${i.unit})` : ''}
                </option>
              ))}
          </Select>
          <Select
            label={t('stock.store')}
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            required
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field
            label={t('stock.quantity')}
            inputMode="numeric"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value.replace(/[^\d]/g, ''))}
            required
          />
          <Field
            label={t('stock.unitCost')}
            inputMode="numeric"
            value={unitCost}
            onChange={(e) => setUnitCost(e.target.value.replace(/[^\d.]/g, ''))}
            required
          />
          <Field
            label={t('stock.batchNo')}
            value={batchNo}
            placeholder={t('stock.batchPh')}
            onChange={(e) => setBatchNo(e.target.value)}
          />
          <Field
            label={t('stock.expiry')}
            type="date"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
          />
        </div>
        <Field
          label={t('stock.supplier')}
          value={supplier}
          placeholder={t('stock.supplierPh')}
          onChange={(e) => setSupplier(e.target.value)}
          wrapperClassName="sm:max-w-md"
        />
        {item && Number(quantity) > 0 && unitCost !== '' && (
          <p className="text-ink-2 m-0 text-[13px]">
            {t('stock.receivePreview', {
              value: formatRwf(Number(quantity) * Number(unitCost)),
              sell:
                item.sellingPrice == null ? '—' : formatRwf(Number(quantity) * item.sellingPrice),
            })}
          </p>
        )}
        {msg && <p className={msg.ok ? okBox : errorBox}>{msg.text}</p>}
        <Button
          type="submit"
          variant="primary"
          className="self-start"
          loading={actions.receive.isPending}
        >
          <PackagePlus size={16} aria-hidden="true" />
          {t('stock.receive')}
        </Button>
      </form>
    </Panel>
  )
}

/* ---------------------------------------------------------------- sending to a desk */
function SendForm({ items, locations }: { items: StockItem[]; locations: StockLocation[] }) {
  const { t } = useTranslation()
  const actions = useStockActions()
  const [itemId, setItemId] = useState('')
  const [from, setFrom] = useState(locations.find((l) => l.type === 'main_store')?.id ?? '')
  const [to, setTo] = useState('')
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const item = items.find((i) => i.id === itemId)
  const available = item ? (item.byLocation[from] ?? 0) : 0
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    const q = Number(quantity)
    if (!itemId) return setMsg({ ok: false, text: t('stock.errors.item') })
    if (!from || !to) return setMsg({ ok: false, text: t('stock.errors.store') })
    if (!Number.isFinite(q) || q <= 0)
      return setMsg({ ok: false, text: t('stock.errors.quantity') })
    if (q > available)
      return setMsg({ ok: false, text: t('stock.errors.short', { count: available }) })
    try {
      await actions.transfer.mutateAsync({ itemId, from, to, quantity: q, reason })
      const toName = locations.find((l) => l.id === to)?.name ?? ''
      setMsg({ ok: true, text: t('stock.sent', { count: q, item: item?.name ?? '', to: toName }) })
      setQuantity('')
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    }
  }
  return (
    <Panel i={1} icon={ArrowRightLeft} tint="teal" title={t('stock.sendTitle')}>
      <p className="text-ink-2 m-0 text-[13px]">{t('stock.sendLead')}</p>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <Select
          label={t('stock.cols.item')}
          value={itemId}
          onChange={(e) => setItemId(e.target.value)}
          required
        >
          <option value="">{t('visit.add.pickItem')}</option>
          {items
            .filter((i) => i.active && i.onHand > 0)
            .map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
                {i.strength ? ` ${i.strength}` : ''} · {t('stock.onHandShort', { count: i.onHand })}
              </option>
            ))}
        </Select>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Select
            label={t('stock.fromStore')}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            required
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {item ? ` · ${item.byLocation[l.id] ?? 0}` : ''}
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
            {locations
              .filter((l) => l.id !== from)
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.department ? ` · ${l.department}` : ''}
                </option>
              ))}
          </Select>
          <Field
            label={t('stock.quantity')}
            inputMode="numeric"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value.replace(/[^\d]/g, ''))}
            required
          />
        </div>
        {item && (
          <p className="text-ink-3 m-0 text-[13px]">
            {t('stock.availableHere', { count: available })}
          </p>
        )}
        <Field
          label={t('stock.reason')}
          value={reason}
          placeholder={t('stock.reasonPh')}
          onChange={(e) => setReason(e.target.value)}
          wrapperClassName="sm:max-w-md"
        />
        {msg && <p className={msg.ok ? okBox : errorBox}>{msg.text}</p>}
        <Button
          type="submit"
          variant="primary"
          className="self-start"
          loading={actions.transfer.isPending}
        >
          <ArrowRightLeft size={16} aria-hidden="true" />
          {t('stock.send')}
        </Button>
      </form>
    </Panel>
  )
}

/* ---------------------------------------------------------------- ledger */
function Movements({ items }: { items: StockItem[] }) {
  const { t } = useTranslation()
  const [from, setFrom] = useState(monthStart)
  const [to, setTo] = useState(() => isoDate(new Date()))
  const [itemId, setItemId] = useState('')
  const { data: moves = [] } = useStockMovements(from, to, itemId || null)
  const paged = usePaged(moves, 20, `${from}|${to}|${itemId}`)
  return (
    <Panel
      i={1}
      icon={ListOrdered}
      tint="navy"
      title={t('stock.movesTitle')}
      right={String(moves.length)}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[auto_auto_minmax(0,1fr)]">
        <Field
          label={t('history.from')}
          type="date"
          value={from}
          max={to}
          onChange={(e) => setFrom(e.target.value)}
        />
        <Field
          label={t('history.to')}
          type="date"
          value={to}
          min={from}
          onChange={(e) => setTo(e.target.value)}
        />
        <Select
          label={t('stock.cols.item')}
          value={itemId}
          onChange={(e) => setItemId(e.target.value)}
          wrapperClassName="col-span-2 sm:col-span-1"
        >
          <option value="">{t('notices.filters.all')}</option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
              {i.strength ? ` ${i.strength}` : ''}
            </option>
          ))}
        </Select>
      </div>
      {paged.total === 0 ? (
        <Empty>{t('stock.noMoves')}</Empty>
      ) : (
        <div className="flex flex-col">
          {paged.slice.map((m) => (
            <div
              key={m.id}
              className="border-grid flex flex-wrap items-center gap-3 border-b py-2 text-[13px] last:border-b-0"
            >
              <span className="text-ink-3 w-24 tabular-nums">
                {formatDate(new Date(m.at))}
                <span className="block text-[12px]">{formatTime(new Date(m.at))}</span>
              </span>
              <Badge
                tone={
                  m.type === 'receipt'
                    ? 'green'
                    : m.type === 'transfer'
                      ? 'blue'
                      : m.type === 'dispense'
                        ? 'yellow'
                        : 'grey'
                }
              >
                {t(`stock.types.${m.type}`)}
              </Badge>
              <span className="min-w-[180px] flex-1">
                <span className="block font-semibold">
                  {m.item} × {formatNumber(m.quantity)}
                </span>
                <span className="text-ink-3 block text-[12px]">
                  {[
                    m.from && m.to ? `${m.from} → ${m.to}` : (m.to ?? m.from),
                    m.batch,
                    m.expiry ? t('stock.exp', { date: formatDate(new Date(m.expiry)) }) : null,
                    m.reason,
                    m.by,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              {m.unitCost != null && (
                <span className="tabular-nums">{formatRwf(m.quantity * m.unitCost)}</span>
              )}
            </div>
          ))}
        </div>
      )}
      <Pager {...paged} onPage={paged.setPage} />
    </Panel>
  )
}

/* ---------------------------------------------------------------- sales and value */
function Sales() {
  const { t } = useTranslation()
  const [from, setFrom] = useState(monthStart)
  const [to, setTo] = useState(() => isoDate(new Date()))
  const { data } = useStockSales(from, to)
  const revenue = data?.items.reduce((s, x) => s + x.revenue, 0) ?? 0
  const cost = data?.items.reduce((s, x) => s + x.cost, 0) ?? 0
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <Field
          label={t('history.from')}
          type="date"
          value={from}
          max={to}
          onChange={(e) => setFrom(e.target.value)}
        />
        <Field
          label={t('history.to')}
          type="date"
          value={to}
          min={from}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
        <Kpi
          i={0}
          icon={Coins}
          tint="mint"
          label={t('stock.sales.revenue')}
          value={revenue}
          unit="RWF"
        />
        <Kpi
          i={1}
          icon={Coins}
          tint="amber"
          label={t('stock.sales.cost')}
          value={Math.round(cost)}
          unit="RWF"
        />
        <Kpi
          i={2}
          icon={Coins}
          tint="violet"
          label={t('stock.sales.margin')}
          value={Math.round(revenue - cost)}
          unit="RWF"
        />
        <Kpi
          i={3}
          icon={Warehouse}
          tint="navy"
          label={t('stock.sales.value')}
          value={Math.round(data?.stockValue ?? 0)}
          unit="RWF"
        />
      </div>
      <Panel i={2} icon={Coins} tint="mint" title={t('stock.sales.byItem')}>
        {!data || data.items.length === 0 ? (
          <Empty>{t('stock.sales.none')}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="text-ink-3 text-left text-[11px] tracking-[.04em] uppercase">
                  <th className="border-border border-b py-2 pr-2 font-semibold">
                    {t('stock.cols.item')}
                  </th>
                  <th className="border-border border-b py-2 pr-2 text-right font-semibold">
                    {t('stock.sales.units')}
                  </th>
                  <th className="border-border border-b py-2 pr-2 text-right font-semibold">
                    {t('stock.sales.revenue')}
                  </th>
                  <th className="border-border hidden border-b py-2 pr-2 text-right font-semibold sm:table-cell">
                    {t('stock.sales.cost')}
                  </th>
                  <th className="border-border border-b py-2 text-right font-semibold">
                    {t('stock.sales.margin')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((x) => (
                  <tr key={x.item} className="border-grid border-b last:border-b-0">
                    <td className="py-2 pr-2 font-semibold">{x.item}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{formatNumber(x.units)}</td>
                    <td className="py-2 pr-2 text-right font-bold tabular-nums">
                      {formatNumber(x.revenue)}
                    </td>
                    <td className="hidden py-2 pr-2 text-right tabular-nums sm:table-cell">
                      {formatNumber(Math.round(x.cost))}
                    </td>
                    <td
                      className={cn(
                        'py-2 text-right font-semibold tabular-nums',
                        x.margin >= 0 ? 'text-green' : 'text-red',
                      )}
                    >
                      {formatNumber(Math.round(x.margin))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-ink-3 m-0 text-[13px]">
          {t('stock.sales.flows', {
            received: formatRwf(Math.round(data?.received ?? 0)),
            consumed: formatRwf(Math.round(data?.consumed ?? 0)),
          })}
        </p>
      </Panel>
    </div>
  )
}

/* ---------------------------------------------------------------- stores */
function Stores({ locations }: { locations: StockLocation[] }) {
  const { t } = useTranslation()
  const actions = useStockActions()
  const { data: departments = [] } = useDepartments()
  const [name, setName] = useState('')
  const [type, setType] = useState<StockLocation['type']>('nursing')
  const [departmentId, setDepartmentId] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    if (name.trim().length < 2) return setMsg({ ok: false, text: t('stock.errors.storeName') })
    try {
      await actions.saveLocation.mutateAsync({ name, type, departmentId: departmentId || null })
      setMsg({ ok: true, text: t('stock.storeSaved', { name }) })
      setName('')
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    }
  }
  return (
    <Panel i={1} icon={Store} tint="amber" title={t('stock.storesTitle')}>
      <p className="text-ink-2 m-0 text-[13px]">{t('stock.storesLead')}</p>
      <div className="flex flex-wrap gap-2">
        {locations.map((l) => (
          <span
            key={l.id}
            className="border-border bg-surface inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[13px]"
          >
            <Store size={14} aria-hidden="true" className="text-ink-3" />
            <b>{l.name}</b>
            <span className="text-ink-3">{t(`stock.storeTypes.${l.type}`)}</span>
            {l.department && <span className="text-violet">{l.department}</span>}
          </span>
        ))}
      </div>
      <form
        onSubmit={(e) => void submit(e)}
        className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
      >
        <Field
          label={t('stock.storeName')}
          value={name}
          placeholder={t('stock.storeNamePh')}
          onChange={(e) => setName(e.target.value)}
        />
        <Select
          label={t('stock.storeType')}
          value={type}
          onChange={(e) => setType(e.target.value as StockLocation['type'])}
        >
          {(['main_store', 'pharmacy', 'nursing', 'lab', 'theatre'] as const).map((x) => (
            <option key={x} value={x}>
              {t(`stock.storeTypes.${x}`)}
            </option>
          ))}
        </Select>
        <Select
          label={t('prices.dept.field')}
          value={departmentId}
          onChange={(e) => setDepartmentId(e.target.value)}
        >
          <option value="">{t('prices.dept.none')}</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="primary" loading={actions.saveLocation.isPending}>
          {t('stock.addStore')}
        </Button>
      </form>
      {msg && <p className={msg.ok ? okBox : errorBox}>{msg.text}</p>}
    </Panel>
  )
}
