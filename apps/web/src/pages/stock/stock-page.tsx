import { useState, type FormEvent } from 'react'
import { PeriodFilter } from '@/components/dash/period-filter'
import { usePeriod } from '@/lib/period'
import {
  AlertTriangle,
  ArrowRightLeft,
  Boxes,
  Coins,
  ListOrdered,
  Package,
  PackageMinus,
  PackagePlus,
  Pill,
  Store,
  Tags,
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
import { SearchSelect } from '@/components/ui/search-select'
import { Flash } from '@/components/ui/flash'
import { StaffShell } from '@/components/staff/staff-shell'
import {
  usePharmacyQueue,
  isLowStock,
  useStockActions,
  useStockMovements,
  useStockOverview,
  useStockSales,
  type StockItem,
  type StockLocation,
} from '@/lib/api/stock'
import { useDepartments } from '@/lib/api/staff'
import {
  medicineRefLabel,
  medicineRuleText,
  readableUnit,
  useMedicineActions,
  useMedicineReference,
  useMedicines,
} from '@/lib/api/catalogue'
import { Reveal } from '@/components/ui/reveal'
import { useClinicInfo } from '@/lib/api/public'
import { ReportButtons } from '@/components/dash/report-buttons'
import { stockReport } from '@/lib/reports/build'
import { useNow } from '@/lib/hooks'
import { navForUser } from '@/lib/nav'
import { matches, usePaged } from '@/lib/paging'
import { useCan } from '@/lib/api/permissions'
import { cn } from '@/lib/utils'
import { useConfirm } from '@/lib/confirm'
import { PharmacyDesk } from './pharmacy-desk'
import { MedicinesSection } from '../prices/medicines-section'

export type Tab =
  'stock' | 'pharmacy' | 'receive' | 'send' | 'use' | 'medicines' | 'moves' | 'sales' | 'stores'
const TABS: { id: Tab; icon: typeof Package }[] = [
  { id: 'stock', icon: Boxes },
  { id: 'pharmacy', icon: Pill },
  { id: 'receive', icon: PackagePlus },
  { id: 'send', icon: ArrowRightLeft },
  { id: 'use', icon: PackageMinus },
  { id: 'medicines', icon: Tags },
  { id: 'moves', icon: ListOrdered },
  { id: 'sales', icon: Coins },
  { id: 'stores', icon: Store },
]
/** What a form opens with: the medicine, the store to receive into, the store to send to. */
export interface StockPreset {
  item?: string
  location?: string
  to?: string
}
/** Opens Receive or Send already filled in (the pharmacy desk's short medicine). */
export type OpenStock = (tab: 'receive' | 'send', preset: StockPreset) => void
const errorBox = 'bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold'

/**
 * Medicine stock (pharmacist, manager): what is on hand and where, with cost and selling price
 * and the value of the stock; receiving; sending a quantity to a department or a doctor's
 * office; the pharmacy hand-over queue; the ledger; what was sold and the margin.
 */
export function StockPage({
  user,
  initialTab,
  preset: initialPreset,
}: {
  user: StaffUser
  initialTab?: Tab
  /** From the address: the medicine and stores the Receive / Send form starts with. */
  preset?: StockPreset
}) {
  const { t } = useTranslation()
  // the pharmacist starts at the hand-over desk
  const [tab, setTab] = useState<Tab>(
    initialTab ?? (user.role === 'pharmacist' ? 'pharmacy' : 'stock'),
  )
  const [preset, setPreset] = useState<StockPreset>(initialPreset ?? {})
  // each time the desk opens a form, it starts again with the new medicine and store
  const [opened, setOpened] = useState(0)
  const openStock: OpenStock = (to, p) => {
    setPreset(p)
    setTab(to)
    setOpened((n) => n + 1)
  }
  const { data, error } = useStockOverview()
  const { data: queue = [] } = usePharmacyQueue()
  const now = useNow(60_000)
  const items = data?.items ?? []
  const { data: info } = useClinicInfo()
  // the report covers a chosen month (this month: up to today)
  const [reportMonth, setReportMonth] = useState(() => isoDate(new Date()).slice(0, 7))
  const [ry, rm] = reportMonth.split('-').map(Number)
  const reportFrom = isoDate(new Date(ry!, rm! - 1, 1))
  const monthEnd = isoDate(new Date(ry!, rm!, 0))
  const reportTo = monthEnd < isoDate(new Date(now)) ? monthEnd : isoDate(new Date(now))
  const { data: reportMoves = [] } = useStockMovements(reportFrom, reportTo, null)
  const { data: reportSales } = useStockSales(reportFrom, reportTo)
  const locations = data?.locations ?? []
  const value = items.reduce((s, i) => s + i.costValue, 0)
  const low = items.filter((i) => i.active && isLowStock(i)).length
  const expiring = items.filter(
    (i) => i.earliestExpiry && new Date(i.earliestExpiry).getTime() < now + 90 * 86_400_000,
  ).length
  // what each role may do here (the database refuses the rest): the pharmacy and the manager
  // run everything; the lab keeps its reagents; nurses and doctors use and look up stock
  const can = useCan(user)
  const fullStock = user.role === 'manager' || user.role === 'pharmacist'
  // receiving, sending, counting: whoever keeps a store (Who may do what decides)
  const keepsStore = can('stock.write')
  const tabs = TABS.filter((x) =>
    x.id === 'pharmacy' || x.id === 'medicines' || x.id === 'sales'
      ? fullStock
      : x.id === 'receive' || x.id === 'send' || x.id === 'stores'
        ? keepsStore
        : true,
  )

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
          <label className="border-border bg-card flex h-10 items-center gap-2 rounded-lg border px-3 text-[14px]">
            <span className="text-ink-3 text-[13px]">{t('stock.reportMonth')}</span>
            <input
              type="month"
              value={reportMonth}
              max={isoDate(new Date()).slice(0, 7)}
              onChange={(e) => e.target.value && setReportMonth(e.target.value)}
              className="bg-transparent outline-none"
            />
          </label>
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
          {tabs.map((x) => (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={tab === x.id}
              onClick={() => {
                // a tab chosen by hand opens empty
                setTab(x.id)
                setPreset({})
              }}
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

        {tab === 'stock' && (
          <StockTable items={items} locations={locations} canSetLevel={fullStock} />
        )}
        {tab === 'pharmacy' && <PharmacyDesk canDispense={fullStock} onOpenStock={openStock} />}
        {tab === 'receive' && (
          <ReceiveForm
            key={opened}
            items={items}
            locations={locations}
            addsMedicines={fullStock}
            preset={preset}
          />
        )}
        {tab === 'send' && (
          <SendForm key={opened} items={items} locations={locations} preset={preset} />
        )}
        {tab === 'use' && <UseForm items={items} locations={locations} />}
        {tab === 'medicines' && (
          <MedicinesTab canEdit={user.role === 'manager' || user.role === 'pharmacist'} />
        )}
        {tab === 'moves' && <Movements items={items} />}
        {tab === 'sales' && <Sales />}
        {tab === 'stores' && (
          <>
            <Stores locations={locations} />
            <CountForm items={items} locations={locations} />
          </>
        )}
      </main>
    </StaffShell>
  )
}

/* ---------------------------------------------------------------- on hand */
function StockTable({
  items,
  locations,
  canSetLevel,
}: {
  items: StockItem[]
  locations: StockLocation[]
  /** The pharmacy and the manager set when a medicine shows as low. */
  canSetLevel: boolean
}) {
  const { t } = useTranslation()
  const actions = useStockActions()
  const confirm = useConfirm()
  const [levelError, setLevelError] = useState<string | null>(null)
  const editLevel = async (i: StockItem) => {
    const raw = window.prompt(t('stock.reorderAsk', { name: i.name }), String(i.reorderLevel))
    if (raw === null) return
    const level = Number(raw.trim())
    if (!Number.isInteger(level) || level < 0) return setLevelError(t('stock.reorderBad'))
    setLevelError(null)
    if (
      !(await confirm({
        title: t('confirm.stock.levelTitle', { item: i.name, level }),
        body: t('confirm.stock.levelBody'),
        confirmLabel: t('confirm.stock.saveYes'),
      }))
    )
      return
    actions.setReorderLevel
      .mutateAsync({ itemId: i.id, level })
      .catch((e: unknown) => setLevelError(e instanceof Error ? e.message : String(e)))
  }
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
      {levelError && (
        <p className="bg-red-bg text-red m-0 rounded-lg px-2.5 py-1.5 text-[13px] font-semibold">
          {levelError}
        </p>
      )}
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
                const lowStock = isLowStock(i)
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
                        {canSetLevel ? (
                          <button
                            type="button"
                            className="text-primary underline-offset-2 hover:underline"
                            title={t('stock.reorderEdit')}
                            onClick={() => void editLevel(i)}
                          >
                            {i.reorderLevel > 0
                              ? t('stock.reorderAt', { count: i.reorderLevel })
                              : t('stock.reorderNone')}
                          </button>
                        ) : i.reorderLevel > 0 ? (
                          t('stock.reorderAt', { count: i.reorderLevel })
                        ) : (
                          t('stock.reorderNone')
                        )}
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

/* ---------------------------------------------------------------- receiving */
/**
 * A delivery comes in. The medicine is chosen, never typed: the clinic's own medicines first,
 * then the RHIA medicines list. An entry of that list becomes a clinic medicine on the way in,
 * with the details of the list where the clinic does not change them. Only who may add medicines
 * (the manager, the pharmacy) sees the list; the others receive the clinic's medicines.
 */
function ReceiveForm({
  items,
  locations,
  addsMedicines,
  preset,
}: {
  items: StockItem[]
  locations: StockLocation[]
  addsMedicines: boolean
  /** The medicine and the store to start with (e.g. a medicine the pharmacy is short of). */
  preset?: StockPreset
}) {
  const { t } = useTranslation()
  const actions = useStockActions()
  const confirm = useConfirm()
  const medicineActions = useMedicineActions()
  const {
    data: reference = [],
    isLoading: refLoading,
    isError: refFailed,
  } = useMedicineReference(addsMedicines)
  const { data: medicines = [] } = useMedicines()
  // "ref:<code>" = an entry of the RHIA list, otherwise a clinic medicine id
  const [itemId, setItemId] = useState(preset?.item ?? '')
  const refCode = itemId.startsWith('ref:') ? itemId.slice(4) : null
  const ref = refCode ? reference.find((r) => r.code === refCode) : undefined
  // the clinic's details for a medicine taken from the list (prefilled from the list)
  const [name, setName] = useState('')
  const [strength, setStrength] = useState('')
  const [form, setForm] = useState('')
  const [unit, setUnit] = useState('')
  const [price, setPrice] = useState('')
  // created already, but the delivery failed: the next try only records the delivery
  const [createdId, setCreatedId] = useState<string | null>(null)
  const clinicCodes = new Set([...items.map((i) => i.code), ...medicines.map((m) => m.code)])
  const options = [
    ...items
      .filter((i) => i.active)
      .map((i) => ({
        value: i.id,
        label: `${i.name}${i.strength ? ` ${i.strength}` : ''}${i.unit ? ` (${i.unit})` : ''}`,
      })),
    ...(addsMedicines ? reference : [])
      .filter((r) => !clinicCodes.has(r.code) || r.code === refCode)
      .map((r) => ({ value: `ref:${r.code}`, label: medicineRefLabel(r, t) })),
  ]
  const pick = (value: string) => {
    setItemId(value)
    setCreatedId(null)
    const r = value.startsWith('ref:') ? reference.find((x) => x.code === value.slice(4)) : null
    if (!r) return
    setName(r.generic)
    setStrength(r.presentation ?? '')
    setForm('')
    setUnit(readableUnit(r.unit))
    setPrice(r.price == null ? '' : String(r.price))
  }
  const [chosenLocation, setLocationId] = useState('')
  // the store asked for (e.g. the pharmacy), else the main store, until another is chosen
  // (the stores may load after the form)
  const presetLocation = locations.find((l) => l.id === preset?.location)?.id
  const locationId =
    chosenLocation ||
    (presetLocation ?? locations.find((l) => l.type === 'main_store')?.id ?? locations[0]?.id ?? '')
  const [quantity, setQuantity] = useState('')
  const [unitCost, setUnitCost] = useState('')
  const [batchNo, setBatchNo] = useState('')
  const [expiry, setExpiry] = useState('')
  const [supplier, setSupplier] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const item = items.find((i) => i.id === itemId)
  const sellingPrice = refCode
    ? price === ''
      ? null
      : Number(price)
    : (item?.sellingPrice ?? null)
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
    if (!expiry) return setMsg({ ok: false, text: t('stock.errors.expiry') })
    const p = Number(price)
    if (refCode) {
      if (name.trim().length < 2) return setMsg({ ok: false, text: t('prices.meds.errors.name') })
      if (!Number.isFinite(p) || p < 0 || price.trim() === '')
        return setMsg({ ok: false, text: t('prices.errors.price') })
    }
    const storeName = locations.find((l) => l.id === locationId)?.name ?? ''
    if (
      !(await confirm({
        title: t('confirm.stock.receiveTitle', {
          quantity: q,
          item: refCode ? name.trim() : (item?.name ?? ''),
          store: storeName,
        }),
        body: [
          t('confirm.stock.receiveBody', { value: formatRwf(q * c) }),
          refCode && !createdId ? t('confirm.stock.receiveNewBody') : '',
        ]
          .filter(Boolean)
          .join(' '),
        confirmLabel: t('confirm.stock.receiveYes'),
      }))
    )
      return
    // set once the medicine is among the clinic's medicines, even if the delivery then fails
    let created = createdId
    try {
      // first the medicine joins the clinic's medicines (with its price), then the delivery
      let id = itemId
      if (refCode) {
        created ??= await medicineActions.save.mutateAsync({
          name,
          strength,
          form,
          unit,
          price: Math.round(p),
          active: true,
          code: refCode,
        })
        setCreatedId(created)
        id = created
      }
      await actions.receive.mutateAsync({
        itemId: id,
        locationId,
        quantity: q,
        unitCost: c,
        batchNo,
        expiry,
        supplier,
        newMedicine: refCode
          ? {
              code: refCode,
              name: name.trim(),
              strength: strength.trim() || null,
              unit: unit.trim() || null,
              sellingPrice: Math.round(p),
            }
          : undefined,
      })
      const value = formatRwf(q * c)
      setMsg({
        ok: true,
        text: refCode
          ? t('stock.ref.received', {
              quantity: q,
              item: name.trim(),
              value,
              price: formatRwf(Math.round(p)),
            })
          : t('stock.received', { count: q, item: item?.name ?? '', value }),
      })
      // from now on it is one of the clinic's medicines
      if (refCode) {
        setItemId(id)
        setCreatedId(null)
      }
      setQuantity('')
      setBatchNo('')
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      setMsg({
        ok: false,
        // the medicine was added, only the delivery is missing: say so, or it looks lost
        text: refCode && created ? t('stock.ref.partial', { item: name.trim(), error }) : error,
      })
    }
  }
  // what the line under the picker says about the RHIA list
  const pickHint = !addsMedicines
    ? t('stock.ref.askHint')
    : refLoading
      ? t('prices.meds.ref.loading')
      : refFailed
        ? t('stock.ref.failed')
        : t('stock.ref.pickHint')
  return (
    <Panel i={1} icon={PackagePlus} tint="mint" title={t('stock.receiveTitle')}>
      <p className="text-ink-2 m-0 text-[13px]">{t('stock.receiveLead')}</p>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SearchSelect
            label={t('stock.cols.item')}
            value={itemId}
            onChange={pick}
            required
            emptyLabel={t('visit.add.pickItem')}
            options={options}
          />
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
        <p className="text-ink-3 m-0 text-[12px]">{pickHint}</p>
        {refCode && (
          <Reveal block="nearest">
            <div className="border-border bg-surface flex flex-col gap-3 rounded-xl border p-3">
              <span>
                <span className="text-ink block text-[14px] font-bold">{t('stock.ref.title')}</span>
                <span className="text-ink-3 block text-[13px]">
                  {t(createdId ? 'stock.ref.locked' : 'stock.ref.hint')}
                </span>
              </span>
              {/* once added to the clinic's medicines, only the delivery is left to record */}
              <fieldset
                disabled={!!createdId}
                className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0 disabled:opacity-60"
              >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field
                    label={t('prices.meds.name')}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                  <Field
                    label={t('prices.meds.ref.presentation')}
                    value={strength}
                    onChange={(e) => setStrength(e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field
                    label={t('prices.meds.form')}
                    value={form}
                    placeholder={t('prices.meds.formPh')}
                    onChange={(e) => setForm(e.target.value)}
                  />
                  <Field
                    label={t('prices.meds.unit')}
                    value={unit}
                    placeholder={t('prices.meds.unitPh')}
                    onChange={(e) => setUnit(e.target.value)}
                  />
                  <Field
                    label={t('prices.meds.price')}
                    inputMode="numeric"
                    value={price}
                    onChange={(e) => setPrice(e.target.value.replace(/[^\d]/g, ''))}
                    required
                  />
                </div>
              </fieldset>
              {ref && (ref.rule || ref.group) && (
                <p className="text-ink-2 m-0 text-[13px]">
                  {[
                    ref.rule ? medicineRuleText(ref.rule, t) : null,
                    ref.group ? t('prices.meds.ref.group', { group: ref.group }) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}
            </div>
          </Reveal>
        )}
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
            required
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
        {(item || refCode) && Number(quantity) > 0 && unitCost !== '' && (
          <p className="text-ink-2 m-0 text-[13px]">
            {t('stock.receivePreview', {
              value: formatRwf(Number(quantity) * Number(unitCost)),
              sell: sellingPrice == null ? '—' : formatRwf(Number(quantity) * sellingPrice),
            })}
          </p>
        )}
        {msg && (
          <Flash key={msg.text} tone={msg.ok ? 'success' : 'error'} onClose={() => setMsg(null)}>
            {msg.text}
          </Flash>
        )}
        <Button
          type="submit"
          variant="primary"
          className="self-start"
          loading={actions.receive.isPending || medicineActions.save.isPending}
        >
          <PackagePlus size={16} aria-hidden="true" />
          {t('stock.receive')}
        </Button>
      </form>
    </Panel>
  )
}

/* ---------------------------------------------------------------- sending to a desk */
function SendForm({
  items,
  locations,
  preset,
}: {
  items: StockItem[]
  locations: StockLocation[]
  /** The medicine and the store to send to (e.g. the pharmacy, short of it). */
  preset?: StockPreset
}) {
  const { t } = useTranslation()
  const actions = useStockActions()
  const confirm = useConfirm()
  const [itemId, setItemId] = useState(preset?.item ?? '')
  const [chosenTo, setTo] = useState('')
  const to = chosenTo || (locations.find((l) => l.id === preset?.to)?.id ?? '')
  const item = items.find((i) => i.id === itemId)
  // expired units are never sent: count only usable stock when the database gives it per store
  const usableAt = (id: string) =>
    item ? ((item.byLocationUsable ?? item.byLocation)[id] ?? 0) : 0
  // the figures per store may still include expired units (the database does not split them yet)
  const mayIncludeExpired = !!item && !item.byLocationUsable && item.expiredUnits > 0
  // sent to a named store: from the other store holding the most of it, else the main store
  const fullest =
    preset?.to && item
      ? locations
          .filter((l) => l.id !== to && usableAt(l.id) > 0)
          .sort((a, b) => usableAt(b.id) - usableAt(a.id))[0]?.id
      : undefined
  const [chosenFrom, setFrom] = useState('')
  const from = chosenFrom || (fullest ?? locations.find((l) => l.type === 'main_store')?.id ?? '')
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const available = usableAt(from)
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
    const toName = locations.find((l) => l.id === to)?.name ?? ''
    if (
      !(await confirm({
        title: t('confirm.stock.sendTitle', {
          quantity: q,
          item: item?.name ?? '',
          from: locations.find((l) => l.id === from)?.name ?? '',
          to: toName,
        }),
        confirmLabel: t('confirm.stock.sendYes'),
      }))
    )
      return
    try {
      await actions.transfer.mutateAsync({ itemId, from, to, quantity: q, reason })
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
        <SearchSelect
          label={t('stock.cols.item')}
          value={itemId}
          onChange={setItemId}
          required
          emptyLabel={t('visit.add.pickItem')}
          options={items
            .filter((i) => i.active && i.onHand > 0)
            .map((i) => ({
              value: i.id,
              label: `${i.name}${i.strength ? ` ${i.strength}` : ''} · ${t('stock.onHandShort', { count: i.onHand })}`,
            }))}
        />
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
                {item ? ` · ${usableAt(l.id)}` : ''}
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
        {mayIncludeExpired && (
          <p className="text-amber m-0 text-[13px]">
            {t('stock.sendExpiredNote', { count: item.expiredUnits })}
          </p>
        )}
        <Field
          label={t('stock.reason')}
          value={reason}
          placeholder={t('stock.reasonPh')}
          onChange={(e) => setReason(e.target.value)}
          wrapperClassName="sm:max-w-md"
        />
        {msg && (
          <Flash key={msg.text} tone={msg.ok ? 'success' : 'error'} onClose={() => setMsg(null)}>
            {msg.text}
          </Flash>
        )}
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

/* ---------------------------------------------------------------- use / write off */
const USE_REASONS = ['expired', 'damaged', 'usedAtDesk', 'countCorrection'] as const
/**
 * Stock that leaves without a sale: expired, damaged, used at a desk (dressings, gloves, reagents)
 * or a count correction. Recorded in the ledger as used, with the reason.
 */
function UseForm({ items, locations }: { items: StockItem[]; locations: StockLocation[] }) {
  const { t } = useTranslation()
  const actions = useStockActions()
  const confirm = useConfirm()
  const [itemId, setItemId] = useState('')
  const [chosenFrom, setFrom] = useState('')
  const from =
    chosenFrom || (locations.find((l) => l.type === 'pharmacy')?.id ?? locations[0]?.id ?? '')
  const [quantity, setQuantity] = useState('')
  const [why, setWhy] = useState<(typeof USE_REASONS)[number]>('expired')
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const item = items.find((i) => i.id === itemId)
  const available = item ? (item.byLocation[from] ?? 0) : 0
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    const q = Number(quantity)
    if (!itemId) return setMsg({ ok: false, text: t('stock.errors.item') })
    if (!from) return setMsg({ ok: false, text: t('stock.errors.store') })
    if (!Number.isFinite(q) || q <= 0)
      return setMsg({ ok: false, text: t('stock.errors.quantity') })
    if (q > available)
      return setMsg({ ok: false, text: t('stock.errors.short', { count: available }) })
    if (
      !(await confirm({
        title: t('confirm.stock.useTitle', {
          quantity: q,
          item: item?.name ?? '',
          store: locations.find((l) => l.id === from)?.name ?? '',
        }),
        body: t('confirm.stock.useBody', { reason: t(`stock.useReasons.${why}`) }),
        confirmLabel: t('confirm.stock.useYes'),
        tone: 'danger',
      }))
    )
      return
    try {
      await actions.use.mutateAsync({
        itemId,
        locationId: from,
        quantity: q,
        reason: [t(`stock.useReasons.${why}`), note.trim()].filter(Boolean).join(': '),
      })
      setMsg({ ok: true, text: t('stock.used', { count: q, item: item?.name ?? '' }) })
      setQuantity('')
      setNote('')
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    }
  }
  return (
    <Panel i={1} icon={PackageMinus} tint="coral" title={t('stock.useTitle')}>
      <p className="text-ink-2 m-0 text-[13px]">{t('stock.useLead')}</p>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <SearchSelect
          label={t('stock.cols.item')}
          value={itemId}
          onChange={setItemId}
          required
          emptyLabel={t('visit.add.pickItem')}
          options={items
            .filter((i) => i.active && i.onHand > 0)
            .map((i) => ({
              value: i.id,
              label: `${i.name}${i.strength ? ` ${i.strength}` : ''} · ${t('stock.onHandShort', { count: i.onHand })}${i.expiredUnits > 0 ? ` · ${t('stock.expired', { count: i.expiredUnits })}` : ''}`,
            }))}
        />
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
            label={t('stock.useWhy')}
            value={why}
            onChange={(e) => setWhy(e.target.value as typeof why)}
          >
            {USE_REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`stock.useReasons.${r}`)}
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
          value={note}
          placeholder={t('stock.useNotePh')}
          onChange={(e) => setNote(e.target.value)}
          wrapperClassName="sm:max-w-md"
        />
        {msg && (
          <Flash key={msg.text} tone={msg.ok ? 'success' : 'error'} onClose={() => setMsg(null)}>
            {msg.text}
          </Flash>
        )}
        <Button
          type="submit"
          variant="primary"
          className="self-start"
          loading={actions.use.isPending}
        >
          <PackageMinus size={16} aria-hidden="true" />
          {t('stock.useSave')}
        </Button>
      </form>
    </Panel>
  )
}

/* ---------------------------------------------------------------- medicines and prices */
/** The medicines list with prices: the pharmacist and the manager add medicines and set prices. */
function MedicinesTab({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation()
  const [notice, setNotice] = useState<string | null>(null)
  if (!canEdit) return <p className={errorBox}>{t('stock.medicinesNotYours')}</p>
  return (
    <div className="flex flex-col gap-3">
      {notice && (
        <Flash key={notice} onClose={() => setNotice(null)}>
          {notice}
        </Flash>
      )}
      <MedicinesSection onNotice={setNotice} />
    </div>
  )
}

/* ---------------------------------------------------------------- ledger */
function Movements({ items }: { items: StockItem[] }) {
  const { t } = useTranslation()
  const period = usePeriod('month')
  const { from, to } = period
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
      <PeriodFilter period={period} />
      <div className="grid grid-cols-1 gap-3 sm:max-w-xl">
        <SearchSelect
          label={t('stock.cols.item')}
          value={itemId}
          onChange={setItemId}
          emptyLabel={t('notices.filters.all')}
          options={items.map((i) => ({
            value: i.id,
            label: `${i.name}${i.strength ? ` ${i.strength}` : ''}`,
          }))}
        />
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
  const period = usePeriod('month')
  const { data } = useStockSales(period.from, period.to)
  const revenue = data?.items.reduce((s, x) => s + x.revenue, 0) ?? 0
  const cost = data?.items.reduce((s, x) => s + x.cost, 0) ?? 0
  return (
    <div className="flex flex-col gap-4">
      <PeriodFilter period={period} />
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
  const confirm = useConfirm()
  const { data: departments = [] } = useDepartments()
  const [name, setName] = useState('')
  const [type, setType] = useState<StockLocation['type']>('nursing')
  const [departmentId, setDepartmentId] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    if (name.trim().length < 2) return setMsg({ ok: false, text: t('stock.errors.storeName') })
    if (
      !(await confirm({
        title: t('confirm.stock.addStoreTitle', { name: name.trim() }),
        confirmLabel: t('confirm.stock.addStoreYes'),
      }))
    )
      return
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
            <b className={cn(l.active === false && 'text-ink-3 line-through')}>{l.name}</b>
            <span className="text-ink-3">{t(`stock.storeTypes.${l.type}`)}</span>
            {l.department && <span className="text-violet">{l.department}</span>}
            <button
              type="button"
              className="text-primary text-[12px] font-semibold underline-offset-2 hover:underline"
              onClick={async () => {
                const closing = l.active !== false
                if (
                  !(await confirm({
                    title: t(
                      closing ? 'confirm.stock.closeStoreTitle' : 'confirm.stock.openStoreTitle',
                      { name: l.name },
                    ),
                    body: closing ? t('confirm.stock.closeStoreBody') : undefined,
                    confirmLabel: t(
                      closing ? 'confirm.stock.closeStoreYes' : 'confirm.stock.openStoreYes',
                    ),
                    tone: closing ? 'danger' : 'primary',
                  }))
                )
                  return
                setMsg(null)
                actions.setLocationActive
                  .mutateAsync({ id: l.id, active: l.active === false })
                  .catch((e: unknown) =>
                    setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }),
                  )
              }}
            >
              {l.active === false ? t('stock.storeOpen') : t('stock.storeClose')}
            </button>
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
      {msg && (
        <Flash key={msg.text} tone={msg.ok ? 'success' : 'error'} onClose={() => setMsg(null)}>
          {msg.text}
        </Flash>
      )}
    </Panel>
  )
}

/** The shelf was counted: the store's stock becomes the count; the difference keeps its reason. */
function CountForm({ items, locations }: { items: StockItem[]; locations: StockLocation[] }) {
  const { t } = useTranslation()
  const actions = useStockActions()
  const confirm = useConfirm()
  const [itemId, setItemId] = useState('')
  const [chosen, setLocationId] = useState('')
  const locationId = chosen || (locations[0]?.id ?? '')
  const [counted, setCounted] = useState('')
  const [reason, setReason] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
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
          item: item?.name ?? '',
          store: locations.find((l) => l.id === locationId)?.name ?? '',
          after: n,
        }),
        body: t('confirm.stock.countBody', { before: current, after: n }),
        confirmLabel: t('confirm.stock.countYes'),
        tone: n < current ? 'danger' : 'primary',
      }))
    )
      return
    try {
      await actions.adjust.mutateAsync({ itemId, locationId, counted: n, reason })
      setMsg({
        ok: true,
        text: t('stock.countSaved', { item: item?.name ?? '', before: current, after: n }),
      })
      setCounted('')
      setReason('')
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    }
  }
  return (
    <Panel i={2} icon={Boxes} tint="teal" title={t('stock.countTitle')}>
      <p className="text-ink-2 m-0 text-[13px]">{t('stock.countLead')}</p>
      <form
        onSubmit={(e) => void submit(e)}
        className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_120px]"
      >
        <SearchSelect
          label={t('stock.cols.item')}
          value={itemId}
          onChange={setItemId}
          emptyLabel={t('visit.add.pickItem')}
          options={items
            .filter((i) => i.active)
            .map((i) => ({ value: i.id, label: `${i.name}${i.strength ? ` ${i.strength}` : ''}` }))}
        />
        <Select
          label={t('stock.store')}
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
        >
          {locations.map((l) => (
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
      {msg && (
        <Flash key={msg.text} tone={msg.ok ? 'success' : 'error'} onClose={() => setMsg(null)}>
          {msg.text}
        </Flash>
      )}
    </Panel>
  )
}
