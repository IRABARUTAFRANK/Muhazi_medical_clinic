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
import { errorKind } from '@/lib/api/errors'
import { useStockActions, useStockOverview } from '@/lib/api/stock'
import { useSession } from '@/store/session'
import { useSessionCanDesk } from '@/components/clinical/session-desks'
import { packPriceText, saleModeText } from '../stock/stock-util'
import {
  emptyPack,
  packChanged,
  packDraftOf,
  packInput,
  packProblem,
  type PackDraft,
} from '../stock/pack-draft'
import { PackagingFields } from '../stock/packaging-fields'

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
                      packOf(m.id) ? saleModeText(t, packOf(m.id)!) : null,
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
  const [active, setActive] = useState(medicine?.active ?? true)
  // the package and how it is sold (0107), read from the stock list (the medicines list does not
  // carry them): pieces only or a pack of N; by the piece, only by the whole pack, or both
  const { data: stock } = useStockOverview()
  const stockActions = useStockActions()
  const qc = useQueryClient()
  const known = medicine ? stock?.items.find((i) => i.id === medicine.id) : undefined
  const [typed, setPack] = useState<PackDraft | null>(null)
  const pack: PackDraft =
    typed ??
    (known
      ? packDraftOf({ ...known, sellingPrice: medicine?.cashPrice ?? known.sellingPrice })
      : {
          ...emptyPack(),
          unit: medicine?.unit ?? '',
          piecePrice: medicine?.cashPrice != null ? String(medicine.cashPrice) : '',
        })
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
    // the list's pack ("B/20") and its tariff as the price of one piece
    setPack({
      ...emptyPack(),
      kind: p?.pack && p.pack > 1 ? 'pack' : 'pieces',
      packSize: p?.pack && p.pack > 1 ? String(p.pack) : '',
      packUnit: p?.pack && p.pack > 1 ? 'box' : '',
      unit: readableUnit(r?.unit ?? null),
      piecePrice: r?.price == null ? '' : String(Math.round(r.price)),
    })
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (name.trim().length < 2) return setError(t('prices.meds.errors.name'))
    const problem = packProblem(t, pack)
    if (problem) return setError(problem)
    const pk = packInput(pack)
    // the cash price of one piece (a pack-only medicine: the pack price / pieces in one)
    const p = pk.piecePrice ?? 0
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
        unit: pk.unit ?? '',
        price: Math.round(p),
        active,
        code: medicine ? undefined : code || undefined,
      })
      const itemId = id || medicine?.id || ''
      if (itemId && (!known || packChanged(pack, known))) {
        await stockActions.setPackaging.mutateAsync({ itemId, ...pk })
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
          <Field
            label={t('prices.meds.form')}
            value={form}
            placeholder={t('prices.meds.formPh')}
            onChange={(e) => setForm(e.target.value)}
          />
          <PackagingFields idPrefix="med" value={pack} onChange={setPack} />
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
