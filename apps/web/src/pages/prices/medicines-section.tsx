import { useState, type FormEvent } from 'react'
import { Pencil, Pill, Plus, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Reveal } from '@/components/ui/reveal'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { ShownList } from '@/components/ui/list-tools'
import { SearchSelect } from '@/components/ui/search-select'
import {
  medicineRefLabel,
  medicineRuleText,
  readableUnit,
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

/**
 * The number of units in one box of a medicine (deliveries counted in boxes are converted with
 * it). Saved by the checked function set_pack_size (the pharmacy and the manager); empty means
 * one unit per box.
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

const errorBox = 'bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold'

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
  const [query, setQuery] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
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
      <div className="bg-green-bg flex flex-wrap items-center gap-3 px-4 py-3">
        <span className="bg-card text-green inline-flex size-10 flex-none items-center justify-center rounded-xl">
          <Pill size={20} aria-hidden="true" />
        </span>
        <span className="min-w-[180px] flex-1">
          <span className="text-green block text-[17px] font-extrabold">
            {t('prices.meds.title')}
          </span>
          <span className="text-ink-2 block text-[13px]">{t('prices.meds.lead')}</span>
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
        <Reveal focus>
          <MedicineForm
            key={editing === 'new' ? 'new' : editing.id}
            medicine={editing === 'new' ? null : editing}
            onClose={() => setEditing(null)}
            onSaved={(name) => {
              setEditing(null)
              onNotice(t('prices.meds.saved', { name }))
            }}
          />
        </Reveal>
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
                className={cn('flex-wrap gap-x-3 gap-y-1 py-2', !m.active && 'opacity-60')}
              >
                <span className="min-w-[180px] flex-1">
                  <span className="text-ink block font-semibold">
                    {m.name}
                    {m.strength ? ` ${m.strength}` : ''}
                  </span>
                  <span className="text-ink-3 text-xs">
                    {[m.code, m.form, m.unit ? t('prices.meds.perUnit', { unit: m.unit }) : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <span className="text-primary text-[15px] font-extrabold tabular-nums">
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
                      variant="ghost"
                      className="hover:text-red"
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
  onSaved: (name: string) => void
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
    setName(r?.generic ?? '')
    setStrength(r?.presentation ?? '')
    setForm('')
    setUnit(readableUnit(r?.unit ?? null))
    setPrice(r?.price == null ? '' : String(r.price))
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
      onSaved(name.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="border-border border-b">
      <CardHeader>
        <span>
          {medicine ? t('prices.meds.editTitle', { name: medicine.name }) : t('prices.meds.new')}
        </span>
      </CardHeader>
      <CardBody className="gap-3">
        {/* while the list loads, or when it cannot be read, say so: typing stays possible */}
        {!medicine && (refLoading || refFailed) && (
          <p className="text-ink-3 m-0 text-[13px]">
            {t(refLoading ? 'prices.meds.ref.loading' : 'prices.meds.ref.failed')}
          </p>
        )}
        {!medicine && reference.length > 0 && (
          <div className="border-border bg-surface flex flex-col gap-2 rounded-xl border p-3">
            <SearchSelect
              label={t('prices.meds.ref.pick')}
              value={code}
              onChange={pickRef}
              emptyLabel={t('prices.meds.ref.none')}
              options={reference
                .filter((r) => !clinicCodes.has(r.code) || r.code === code)
                .map((r) => ({ value: r.code, label: medicineRefLabel(r, t) }))}
            />
            {code ? (
              <>
                <p className="text-ink-2 m-0 text-[13px]">
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
                  variant="ghost"
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
        <Field
          label={t('prices.meds.packSize')}
          inputMode="numeric"
          value={pack}
          placeholder="100"
          onChange={(e) => setPackSize(e.target.value.replace(/[^\d]/g, ''))}
          wrapperClassName="sm:max-w-xs"
        />
        <p className="text-ink-3 m-0 -mt-1 text-[12px]">{t('prices.meds.packHint')}</p>
        <label className="border-border flex items-start gap-3 rounded-xl border p-3">
          <input
            type="checkbox"
            className="accent-primary mt-0.5 size-[18px] flex-none"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
          <span>
            <span className="block text-[13px] font-semibold">{t('prices.meds.active')}</span>
            <span className="text-ink-3 block text-xs">{t('prices.meds.activeHint')}</span>
          </span>
        </label>
        {error && (
          <p role="alert" className={errorBox}>
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={actions.save.isPending}>
            {t('prices.form.save')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('staff.form.cancel')}
          </Button>
        </div>
      </CardBody>
    </form>
  )
}
