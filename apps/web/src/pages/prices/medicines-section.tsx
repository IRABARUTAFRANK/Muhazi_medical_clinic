import { useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { PackagePlus, Pencil, Pill, Plus, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardBody, Row } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { SidePanel } from '@/components/ui/side-panel'
import { ShownList } from '@/components/ui/list-tools'
import { SearchSelect } from '@/components/ui/search-select'
import {
  medicineRefOption,
  medicineRefParts,
  medicineRuleText,
  readableUnit,
  sortMedicineRefs,
  useMedicineActions,
  useMedicineReference,
  useMedicines,
  type Medicine,
} from '@/lib/api/catalogue'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { useConfirm } from '@/lib/confirm'
import { errorKind, throwIf } from '@/lib/api/errors'
import { sampleStock, useStockOverview } from '@/lib/api/stock'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'
import { useSessionCanDesk } from '@/components/clinical/session-desks'
import { packPriceText, tx } from '../stock/stock-util'

/**
 * The number of pieces in one pack of a medicine (a box of 20 tablets, a strip of 10; deliveries
 * counted in boxes are converted with it; stock is held in pieces). Saved by the checked function
 * set_pack_size (the pharmacy and the manager); empty means one piece per pack: a medicine sold
 * whole, like a bottle, has 1 and the unit "bottle".
 */
async function savePackSize(itemId: string, packSize: number | null) {
  if (!itemId) return
  if (!supabase) {
    // sample mode: the stock list shows it
    const it = sampleStock.items.find((x) => x.id === itemId)
    if (it) it.packSize = packSize
    return
  }
  const { error } = await supabase.rpc('set_pack_size', {
    p_item_id: itemId,
    p_pack: packSize ?? 1,
  })
  throwIf(error)
}

/**
 * The price of one whole pack (0102), when it differs from pieces × the price: whole packs sold
 * for cash are charged at it. Saved by set_pack_price (the manager, or the price right); empty
 * clears it.
 */
async function savePackPrice(itemId: string, packPrice: number | null) {
  if (!itemId) return
  if (!supabase) {
    const it = sampleStock.items.find((x) => x.id === itemId)
    if (it) it.packPrice = packPrice
    return
  }
  const { error } = await supabase.rpc('set_pack_price', { p_item_id: itemId, p_price: packPrice })
  throwIf(error)
}

const errorBox =
  'border-red/30 bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[14px] font-medium'
/** The medicine form opens in a side panel; the panel's footer submits it by this id. */
const MEDICINE_FORM = 'medicine-form'

/**
 * Medicines and supplies with their price (manager). Anything listed here can be put on the
 * bill at any desk, and is charged when a doctor or nurse gives it in the room.
 */
export function MedicinesSection({ onNotice }: { onNotice: (text: string) => void }) {
  const { t } = useTranslation()
  const { data: meds = [], error } = useMedicines()
  const actions = useMedicineActions()
  const confirm = useConfirm()
  // only the manager deletes a medicine (catalogue.write); the database refuses it while stock
  // remains
  const canDelete = useSession((s) => s.user?.role === 'manager')
  const [editing, setEditing] = useState<Medicine | 'new' | null>(null)
  // a medicine just created: it is in the list with no stock yet (Add stock puts some in)
  const [added, setAdded] = useState<{ id: string; name: string } | null>(null)
  const isManager = useSession((s) => s.user?.role === 'manager')
  const canDesk = useSessionCanDesk()
  const mayAddStock = isManager || canDesk('pharmacy')
  const [query, setQuery] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  // the pack (pieces in one, the pack price) lives on the stock list
  const { data: stock } = useStockOverview()
  const packOf = (id: string) => stock?.items.find((i) => i.id === id)
  const q = query.trim().toLowerCase()
  const shown = meds.filter(
    (m) =>
      !q || `${m.name} ${m.strength ?? ''} ${m.form ?? ''} ${m.code}`.toLowerCase().includes(q),
  )

  const remove = async (m: Medicine) => {
    if (
      !(await confirm({
        title: t('confirm.prices.deleteMedicineTitle', {
          name: `${m.name}${m.strength ? ` ${m.strength}` : ''}`,
        }),
        body: t('confirm.prices.deleteMedicineBody'),
        confirmLabel: t('confirm.prices.deleteYes'),
        tone: 'danger',
      }))
    )
      return
    setActionError(null)
    try {
      await actions.remove.mutateAsync(m.id)
      onNotice(t('prices.deleted', { name: m.name }))
    } catch (e) {
      setActionError(
        errorKind(e) === 'hasStock' || /has_stock|stock remains/i.test(String(e))
          ? t('prices.meds.hasStock', { name: m.name })
          : e instanceof Error
            ? e.message
            : String(e),
      )
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="border-border bg-green-bg flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <span className="bg-card text-green inline-flex size-8 flex-none items-center justify-center rounded">
          <Pill size={18} aria-hidden="true" />
        </span>
        <span className="min-w-[180px] flex-1">
          <span className="text-green block text-[16px] font-semibold">
            {t('prices.meds.title')}
          </span>
          <span className="text-ink-2 block text-[14px]">{t('prices.meds.lead')}</span>
        </span>
        <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
          <Plus size={14} aria-hidden="true" />
          {t('prices.meds.new')}
        </Button>
      </div>
      {(error || actionError) && (
        <p role="alert" className={cn(errorBox, 'mx-4 mt-3')}>
          {actionError ?? error?.message}
        </p>
      )}
      {editing && (
        <MedicineForm
          key={editing === 'new' ? 'new' : editing.id}
          medicine={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(name, id) => {
            const created = editing === 'new'
            setEditing(null)
            onNotice(t('prices.meds.saved', { name }))
            setAdded(created && id ? { id, name } : null)
          }}
        />
      )}
      {added && (
        <div
          role="status"
          className="border-amber/40 bg-amber-bg/60 mx-4 mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border px-3 py-2.5"
        >
          <PackagePlus size={18} aria-hidden="true" className="text-amber flex-none" />
          <span className="min-w-0 flex-[1_1_16rem] text-[14px]">
            <b className="block">{t('prices.meds.addedNoStock', { name: added.name })}</b>
            <span className="text-ink-2">{t('prices.meds.addedHow')}</span>
          </span>
          {mayAddStock && (
            <Link
              to="/app/stock"
              search={{ tab: 'add', item: added.id }}
              className={buttonVariants({ variant: 'primary', size: 'sm' })}
            >
              <PackagePlus size={14} aria-hidden="true" />
              {t('prices.meds.addStockNow')}
            </Link>
          )}
          <button
            type="button"
            onClick={() => setAdded(null)}
            aria-label={t('common.close')}
            className="text-ink-3 hover:text-ink inline-flex size-8 items-center justify-center rounded"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}
      <CardBody className="border-border border-b py-2.5">
        <Field
          label={t('prices.meds.search')}
          value={query}
          placeholder={t('prices.meds.searchPh')}
          onChange={(e) => setQuery(e.target.value)}
        />
      </CardBody>
      {shown.length === 0 ? (
        <p className="text-ink-3 m-0 px-4 py-3 text-[13px]">{t('prices.meds.empty')}</p>
      ) : (
        <ShownList step={10} footerClassName="px-4 py-2" items={shown}>
          {(rows) =>
            rows.map((m) => (
              <Row
                key={m.id}
                className={cn(
                  'flex-wrap gap-x-3 gap-y-1 py-2',
                  !m.active && 'opacity-60',
                  editing !== 'new' && editing?.id === m.id && 'bg-primary-tint/50',
                )}
              >
                <span className="min-w-[180px] flex-1">
                  <span className="text-ink block font-semibold">
                    {m.name}
                    {m.strength ? ` ${m.strength}` : ''}
                  </span>
                  <span className="text-ink-3 text-xs">
                    {[
                      m.code,
                      m.form,
                      m.unit ? t('prices.meds.perUnit', { unit: m.unit }) : null,
                      (packOf(m.id)?.packSize ?? 1) > 1
                        ? t('stockPage.add.perBoxKnown', { count: packOf(m.id)?.packSize })
                        : null,
                      packOf(m.id) ? packPriceText(t, packOf(m.id)!, formatRwf) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <span className="text-primary text-[16px] font-semibold tabular-nums">
                  {m.cashPrice == null ? t('prices.noPrice') : formatRwf(m.cashPrice)}
                </span>
                {!m.active && <Badge tone="grey">{t('prices.inactive')}</Badge>}
                <span className="flex flex-wrap gap-1">
                  <Button size="sm" onClick={() => setEditing(m)}>
                    <Pencil size={14} aria-hidden="true" />
                    {t('prices.edit')}
                  </Button>
                  {canDelete && (
                    <Button
                      size="sm"
                      variant="tint-coral"
                      title={t('prices.delete')}
                      aria-label={t('prices.delete')}
                      onClick={() => void remove(m)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </Button>
                  )}
                </span>
              </Row>
            ))
          }
        </ShownList>
      )}
    </Card>
  )
}

function MedicineForm({
  medicine,
  onClose,
  onSaved,
}: {
  medicine: Medicine | null
  onClose: () => void
  onSaved: (name: string, id: string | null) => void
}) {
  const { t } = useTranslation()
  const actions = useMedicineActions()
  const confirm = useConfirm()
  const [name, setName] = useState(medicine?.name ?? '')
  const [strength, setStrength] = useState(medicine?.strength ?? '')
  const [form, setForm] = useState(medicine?.form ?? '')
  const [unit, setUnit] = useState(medicine?.unit ?? '')
  const [price, setPrice] = useState(medicine?.cashPrice != null ? String(medicine.cashPrice) : '')
  const [active, setActive] = useState(medicine?.active ?? true)
  // the box size, read from the stock list (the medicines list does not carry it)
  const { data: stock } = useStockOverview()
  const qc = useQueryClient()
  const knownPack = medicine
    ? (stock?.items.find((i) => i.id === medicine.id)?.packSize ?? null)
    : null
  const [packSize, setPackSize] = useState<string | null>(null)
  const pack = packSize ?? (knownPack && knownPack > 0 ? String(knownPack) : '')
  // the price of one whole pack (0102), optional
  const knownPackPrice = medicine
    ? (stock?.items.find((i) => i.id === medicine.id)?.packPrice ?? null)
    : null
  const [packPrice, setPackPrice] = useState<string | null>(null)
  const packPriceField = packPrice ?? (knownPackPrice != null ? String(knownPackPrice) : '')
  const [error, setError] = useState<string | null>(null)
  // a new medicine can be taken from the RHIA list: its code keeps the list's details with it
  const {
    data: reference = [],
    isLoading: refLoading,
    isError: refFailed,
  } = useMedicineReference(!medicine)
  const { data: meds = [] } = useMedicines()
  const [code, setCode] = useState('')
  const ref = code ? reference.find((r) => r.code === code) : undefined
  const clinicCodes = new Set(meds.map((m) => m.code))
  const pickRef = (value: string) => {
    setCode(value)
    const r = reference.find((x) => x.code === value)
    // the list's wording made clean: name (with the brand when it has one), strength, form, unit
    const p = r ? medicineRefParts(r) : null
    setName(p ? (p.brand ? `${p.genericOnly} (${p.brand})` : p.genericOnly) : '')
    setStrength(p?.strengthText ?? '')
    setForm(p?.form ?? '')
    setUnit(readableUnit(r?.unit ?? null))
    setPrice(r?.price == null ? '' : String(r.price))
    setPackSize(p?.pack ? String(p.pack) : null)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    const p = Number(price)
    if (name.trim().length < 2) return setError(t('prices.meds.errors.name'))
    if (!Number.isFinite(p) || p < 0 || price.trim() === '')
      return setError(t('prices.errors.price'))
    const ps = pack.trim() === '' ? null : Number(pack)
    if (ps != null && (!Number.isInteger(ps) || ps < 1)) return setError(t('prices.meds.packBad'))
    const pp = packPriceField.trim() === '' ? null : Number(packPriceField)
    if (pp != null && (!Number.isInteger(pp) || pp < 0))
      return setError(
        tx(t, 'prices.meds.packPriceBad', 'The pack price is a whole number, 0 or more.'),
      )
    if (pp != null && (ps ?? 1) < 2)
      return setError(
        tx(
          t,
          'prices.meds.packPriceNeedsSize',
          'A pack price needs the units per box first (2 or more). A medicine sold whole has no pack price: its price is the price.',
        ),
      )
    const label = `${name.trim()}${strength.trim() ? ` ${strength.trim()}` : ''}`
    if (
      !(await confirm({
        title: t(
          medicine ? 'confirm.prices.saveMedicineTitle' : 'confirm.prices.addMedicineTitle',
          {
            name: label,
            price: formatRwf(Math.round(p)),
          },
        ),
        body: active ? undefined : t('confirm.prices.inactiveBody'),
        confirmLabel: t('confirm.prices.saveYes'),
      }))
    )
      return
    try {
      const id = await actions.save.mutateAsync({
        id: medicine?.id,
        name,
        strength,
        form,
        unit,
        price: Math.round(p),
        active,
        code: medicine ? undefined : code || undefined,
      })
      if (ps !== knownPack) {
        await savePackSize(id || medicine?.id || '', ps)
        void qc.invalidateQueries({ queryKey: ['stock'] })
      }
      if (pp !== knownPackPrice) {
        await savePackPrice(id || medicine?.id || '', pp)
        void qc.invalidateQueries({ queryKey: ['stock'] })
      }
      onSaved(name.trim(), id || medicine?.id || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <SidePanel
      open
      onClose={onClose}
      hue="amber"
      icon={Pill}
      title={medicine ? t('prices.meds.editTitle', { name: medicine.name }) : t('prices.meds.new')}
      subtitle={
        medicine
          ? [medicine.code, medicine.strength, medicine.form].filter(Boolean).join(' · ')
          : undefined
      }
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('staff.form.cancel')}
          </Button>
          <Button
            type="submit"
            form={MEDICINE_FORM}
            variant="primary"
            loading={actions.save.isPending}
          >
            {t('prices.form.save')}
          </Button>
        </>
      }
    >
      <form id={MEDICINE_FORM} onSubmit={(e) => void submit(e)}>
        <CardBody className="gap-3 p-0">
          {/* while the list loads, or when it cannot be read, say so: typing stays possible */}
          {!medicine && (refLoading || refFailed) && (
            <p className="text-ink-3 m-0 text-[13px]">
              {t(refLoading ? 'prices.meds.ref.loading' : 'prices.meds.ref.failed')}
            </p>
          )}
          {!medicine && reference.length > 0 && (
            <div className="border-border bg-surface flex flex-col gap-2 rounded-md border p-3">
              <SearchSelect
                label={t('prices.meds.ref.pick')}
                value={code}
                onChange={pickRef}
                emptyLabel={t('prices.meds.ref.none')}
                options={sortMedicineRefs(reference)
                  .filter((r) => !clinicCodes.has(r.code) || r.code === code)
                  .map((r) => medicineRefOption(r, t))}
              />
              {code ? (
                <>
                  <p className="text-ink-2 m-0 text-[14px]">
                    {[
                      t('prices.meds.ref.note'),
                      ref?.rule ? medicineRuleText(ref.rule, t) : null,
                      ref?.group ? t('prices.meds.ref.group', { group: ref.group }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="tint-grey"
                    className="self-start"
                    onClick={() => pickRef('')}
                  >
                    <X size={14} aria-hidden="true" />
                    {t('prices.meds.ref.clear')}
                  </Button>
                </>
              ) : (
                <p className="text-ink-3 m-0 text-[12px]">{t('prices.meds.ref.byHand')}</p>
              )}
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label={t('prices.meds.name')}
              value={name}
              placeholder={t('prices.meds.namePh')}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <Field
              label={t('prices.meds.strength')}
              value={strength}
              placeholder="500 mg"
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
              placeholder="500"
              onChange={(e) => setPrice(e.target.value.replace(/[^\d]/g, ''))}
              required
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label={t('prices.meds.packSize')}
              inputMode="numeric"
              value={pack}
              placeholder="100"
              onChange={(e) => setPackSize(e.target.value.replace(/[^\d]/g, ''))}
            />
            <Field
              label={tx(t, 'prices.meds.packPrice', 'Pack price (optional)')}
              inputMode="numeric"
              value={packPriceField}
              placeholder={
                pack.trim() !== '' && price.trim() !== ''
                  ? String(Number(pack) * Number(price))
                  : '—'
              }
              onChange={(e) => setPackPrice(e.target.value.replace(/[^\d]/g, ''))}
            />
          </div>
          <p className="text-ink-3 m-0 -mt-1 text-[12px]">
            {t('prices.meds.packHint')}{' '}
            {tx(
              t,
              'prices.meds.packHint2',
              'Stock is held in pieces (the unit above); the box size says how many pieces make one pack, so every screen can show both ("500 tab · 25 packs of 20"). A medicine sold whole, like a bottle of syrup, is 1 with the unit "bottle". The pack price is the price of one whole pack when it differs from pieces × price: whole packs sold for cash are charged at it, and the bill says so.',
            )}
          </p>
          <label className="border-border flex items-start gap-3 rounded-md border p-3">
            <input
              type="checkbox"
              className="accent-primary mt-0.5 size-[18px] flex-none"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            <span>
              <span className="block text-[14px] font-semibold">{t('prices.meds.active')}</span>
              <span className="text-ink-3 block text-xs">{t('prices.meds.activeHint')}</span>
            </span>
          </label>
          {error && (
            <p role="alert" className={errorBox}>
              {error}
            </p>
          )}
        </CardBody>
      </form>
    </SidePanel>
  )
}
