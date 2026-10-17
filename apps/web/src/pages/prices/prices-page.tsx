import { useState, type FormEvent } from 'react'
import { Pencil, Plus, ShieldCheck, Tag } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CATEGORY_IDS, formatRwf, type CategoryId, type StaffUser } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Chip } from '@/components/ui/chip'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { StaffShell } from '@/components/staff/staff-shell'
import {
  PAYER_TYPES,
  SERVICE_GROUPS,
  useCatalogueActions,
  useInsurers,
  useTreatments,
  type Insurer,
  type PayerType,
  type ServiceGroup,
  type Treatment,
} from '@/lib/api/catalogue'
import { navForUser } from '@/lib/nav'
import { cn } from '@/lib/utils'

const errorBox = 'bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold'

/**
 * Manager: the treatment catalogue (what the clinic treats, the price, the discount a
 * clinician may give), the insurers the clinic works with and what each one covers.
 */
export function PricesPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const { data: treatments = [], error: tError } = useTreatments()
  const { data: insurers = [], error: iError } = useInsurers()
  const [editing, setEditing] = useState<Treatment | 'new' | null>(null)
  const [editingInsurer, setEditingInsurer] = useState<Insurer | 'new' | null>(null)

  const groups = SERVICE_GROUPS.filter((g) => treatments.some((x) => x.group === g))
  const activeInsurers = insurers.filter((i) => i.active)

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="prices">
      <main className="pc:px-6 pc:pb-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[260px] flex-1">
            <h1 className="m-0 text-2xl font-bold">{t('prices.title')}</h1>
            <p className="text-ink-2 m-0 mt-1 max-w-[720px]">{t('prices.lead')}</p>
          </div>
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Plus size={18} aria-hidden="true" />
            {t('prices.newTreatment')}
          </Button>
        </div>

        {(tError || iError) && (
          <p role="alert" className={errorBox}>
            {(tError ?? iError)?.message}
          </p>
        )}

        {editing && (
          <TreatmentForm
            key={editing === 'new' ? 'new' : editing.id}
            treatment={editing === 'new' ? null : editing}
            insurers={activeInsurers}
            onClose={() => setEditing(null)}
          />
        )}

        {/* Treatments by group */}
        {groups.map((g) => (
          <Card key={g}>
            <CardHeader>
              <span className="inline-flex items-center gap-2">
                <Tag size={16} aria-hidden="true" />
                {t(`prices.groups.${g}`)}
              </span>
              <span className="text-ink-3 text-xs">
                {treatments.filter((x) => x.group === g).length}
              </span>
            </CardHeader>
            {treatments
              .filter((x) => x.group === g)
              .map((x) => (
                <Row
                  key={x.id}
                  className={cn('flex-wrap gap-x-4 gap-y-1 py-2', !x.active && 'opacity-60')}
                >
                  <span className="min-w-[200px] flex-1">
                    <span className="block font-semibold">{x.nameEn}</span>
                    <span className="text-ink-3 text-xs">
                      {x.code}
                      {x.nameKin ? ` · ${x.nameKin}` : ''}
                      {x.nameFr ? ` · ${x.nameFr}` : ''}
                    </span>
                  </span>
                  <span className="font-bold tabular-nums">
                    {x.cashPrice == null
                      ? t('prices.noPrice')
                      : x.cashPrice === 0
                        ? t('price.free')
                        : formatRwf(x.cashPrice)}
                  </span>
                  {activeInsurers.map((i) =>
                    x.payerPrices[i.id] != null ? (
                      <Chip key={i.id}>
                        {i.code}: {formatRwf(x.payerPrices[i.id]!)}
                      </Chip>
                    ) : null,
                  )}
                  <Chip>{t('prices.maxDiscount', { pct: x.maxDiscountPct })}</Chip>
                  {!x.active && <Badge tone="grey">{t('prices.inactive')}</Badge>}
                  <Button size="sm" onClick={() => setEditing(x)}>
                    <Pencil size={14} aria-hidden="true" />
                    {t('prices.edit')}
                  </Button>
                </Row>
              ))}
          </Card>
        ))}

        {/* Insurers and coverage */}
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <div className="min-w-[260px] flex-1">
            <h2 className="m-0 text-xl font-bold">{t('prices.insurers.title')}</h2>
            <p className="text-ink-2 m-0 mt-1 max-w-[720px]">{t('prices.insurers.lead')}</p>
          </div>
          <Button onClick={() => setEditingInsurer('new')}>
            <Plus size={18} aria-hidden="true" />
            {t('prices.insurers.new')}
          </Button>
        </div>

        {editingInsurer && (
          <InsurerForm
            key={editingInsurer === 'new' ? 'new' : editingInsurer.id}
            insurer={editingInsurer === 'new' ? null : editingInsurer}
            onClose={() => setEditingInsurer(null)}
          />
        )}

        <Card>
          <CardHeader>
            <span className="inline-flex items-center gap-2">
              <ShieldCheck size={16} aria-hidden="true" />
              {t('prices.insurers.list')}
            </span>
            <span className="text-ink-3 text-xs">
              {t('prices.insurers.activeCount', { count: activeInsurers.length })}
            </span>
          </CardHeader>
          {insurers.length === 0 && (
            <CardBody>
              <p className="text-ink-3 m-0 text-[13px]">{t('prices.insurers.none')}</p>
            </CardBody>
          )}
          {insurers.map((i) => (
            <Row
              key={i.id}
              className={cn('flex-wrap gap-x-4 gap-y-1 py-2', !i.active && 'opacity-60')}
            >
              <span className="min-w-[200px] flex-1">
                <span className="block font-semibold">{i.name}</span>
                <span className="text-ink-3 text-xs">
                  {i.code} · {t(`prices.insurers.types.${i.type}`)}
                </span>
              </span>
              <span className="font-bold tabular-nums">
                {t('prices.insurers.covers', { pct: i.coveragePct })}
              </span>
              {Object.entries(i.pctByGroup).map(([g, pct]) => (
                <Chip key={g}>
                  {t(`prices.groups.${g}`)}: {pct}%
                </Chip>
              ))}
              {i.active ? (
                <Badge tone="green">{t('prices.insurers.active')}</Badge>
              ) : (
                <Badge tone="grey">{t('prices.insurers.inactive')}</Badge>
              )}
              <Button size="sm" onClick={() => setEditingInsurer(i)}>
                <Pencil size={14} aria-hidden="true" />
                {t('prices.edit')}
              </Button>
            </Row>
          ))}
        </Card>
      </main>
    </StaffShell>
  )
}

/* ---------------------------------------------------------------- treatment form */

function TreatmentForm({
  treatment,
  insurers,
  onClose,
}: {
  treatment: Treatment | null
  insurers: Insurer[]
  onClose: () => void
}) {
  const { t } = useTranslation()
  const actions = useCatalogueActions()
  const [nameEn, setNameEn] = useState(treatment?.nameEn ?? '')
  const [nameKin, setNameKin] = useState(treatment?.nameKin ?? '')
  const [nameFr, setNameFr] = useState(treatment?.nameFr ?? '')
  const [group, setGroup] = useState<ServiceGroup>(treatment?.group ?? 'consultation')
  const [category, setCategory] = useState<CategoryId | ''>(treatment?.bookingCategory ?? '')
  const [price, setPrice] = useState(
    treatment?.cashPrice != null ? String(treatment.cashPrice) : '',
  )
  const [maxDiscount, setMaxDiscount] = useState(String(treatment?.maxDiscountPct ?? 0))
  const [allowManual, setAllowManual] = useState(treatment?.allowManualPrice ?? false)
  const [active, setActive] = useState(treatment?.active ?? true)
  const [payerPrices, setPayerPrices] = useState<Record<string, string>>(
    Object.fromEntries(
      insurers.map((i) => [
        i.id,
        treatment?.payerPrices[i.id] != null ? String(treatment.payerPrices[i.id]) : '',
      ]),
    ),
  )
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    const p = Number(price)
    const d = Number(maxDiscount)
    if (!nameEn.trim()) return setError(t('prices.errors.name'))
    if (!Number.isFinite(p) || p < 0) return setError(t('prices.errors.price'))
    if (!Number.isFinite(d) || d < 0 || d > 100) return setError(t('prices.errors.discount'))
    try {
      await actions.saveTreatment.mutateAsync({
        id: treatment?.id,
        nameEn,
        nameKin,
        nameFr,
        group,
        bookingCategory: category || null,
        cashPrice: Math.round(p),
        maxDiscountPct: d,
        allowManualPrice: allowManual,
        active,
        payerPrices,
      })
      onClose()
    } catch (err) {
      setError(t('prices.errors.generic', { message: err instanceof Error ? err.message : '' }))
    }
  }

  return (
    <Card className="border-primary">
      <CardHeader>
        <span>
          {treatment
            ? t('prices.form.editTitle', { name: treatment.nameEn })
            : t('prices.newTreatment')}
        </span>
      </CardHeader>
      <form onSubmit={submit}>
        <CardBody className="gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field
              label={t('prices.form.nameEn')}
              value={nameEn}
              onChange={(e) => setNameEn(e.target.value)}
              placeholder={t('prices.form.namePh')}
              required
            />
            <Field
              label={t('prices.form.nameKin')}
              value={nameKin}
              onChange={(e) => setNameKin(e.target.value)}
            />
            <Field
              label={t('prices.form.nameFr')}
              value={nameFr}
              onChange={(e) => setNameFr(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Select
              label={t('prices.form.group')}
              value={group}
              onChange={(e) => setGroup(e.target.value as ServiceGroup)}
            >
              {SERVICE_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {t(`prices.groups.${g}`)}
                </option>
              ))}
            </Select>
            <Select
              label={t('prices.form.category')}
              value={category}
              onChange={(e) => setCategory(e.target.value as CategoryId | '')}
            >
              <option value="">{t('prices.form.categoryNone')}</option>
              {CATEGORY_IDS.map((c) => (
                <option key={c} value={c}>
                  {t(`categories.${c}`)}
                </option>
              ))}
            </Select>
            <Field
              label={t('prices.form.cashPrice')}
              inputMode="numeric"
              value={price}
              onChange={(e) => setPrice(e.target.value.replace(/[^\d]/g, ''))}
              placeholder="8000"
              required
            />
            <Field
              label={t('prices.form.maxDiscount')}
              inputMode="numeric"
              value={maxDiscount}
              onChange={(e) => setMaxDiscount(e.target.value.replace(/[^\d.]/g, '').slice(0, 5))}
            />
          </div>
          {insurers.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-ink-2 text-[13px] font-semibold">
                {t('prices.form.insurerPrices')}
              </span>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {insurers.map((i) => (
                  <Field
                    key={i.id}
                    label={i.name}
                    inputMode="numeric"
                    value={payerPrices[i.id] ?? ''}
                    onChange={(e) =>
                      setPayerPrices((s) => ({
                        ...s,
                        [i.id]: e.target.value.replace(/[^\d]/g, ''),
                      }))
                    }
                    placeholder={t('prices.form.sameAsCash')}
                  />
                ))}
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-5">
            <label className="flex min-h-11 items-center gap-2 text-[13px] font-semibold">
              <input
                type="checkbox"
                className="accent-primary size-[18px]"
                checked={allowManual}
                onChange={(e) => setAllowManual(e.target.checked)}
              />
              {t('prices.form.allowManual')}
            </label>
            <label className="flex min-h-11 items-center gap-2 text-[13px] font-semibold">
              <input
                type="checkbox"
                className="accent-primary size-[18px]"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              {t('prices.form.active')}
            </label>
          </div>
          {error && (
            <p role="alert" className={errorBox}>
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={actions.saveTreatment.isPending}>
              {actions.saveTreatment.isPending ? t('settings.saving') : t('prices.form.save')}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('staff.form.cancel')}
            </Button>
          </div>
        </CardBody>
      </form>
    </Card>
  )
}

/* ---------------------------------------------------------------- insurer form */

function InsurerForm({ insurer, onClose }: { insurer: Insurer | null; onClose: () => void }) {
  const { t } = useTranslation()
  const actions = useCatalogueActions()
  const [name, setName] = useState(insurer?.name ?? '')
  const [code, setCode] = useState(insurer?.code ?? '')
  const [type, setType] = useState<PayerType>(insurer?.type ?? 'private')
  const [coverage, setCoverage] = useState(String(insurer?.coveragePct ?? 80))
  const [active, setActive] = useState(insurer?.active ?? true)
  const [byGroup, setByGroup] = useState<Record<string, string>>(
    Object.fromEntries(
      SERVICE_GROUPS.map((g) => [
        g,
        insurer?.pctByGroup[g] != null ? String(insurer.pctByGroup[g]) : '',
      ]),
    ),
  )
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    const c = Number(coverage)
    if (!name.trim()) return setError(t('prices.errors.name'))
    if (!Number.isFinite(c) || c < 0 || c > 100) return setError(t('prices.errors.coverage'))
    const pctByGroup: Partial<Record<ServiceGroup, number>> = {}
    for (const g of SERVICE_GROUPS) {
      const v = byGroup[g]?.trim()
      if (v) {
        const n = Number(v)
        if (!Number.isFinite(n) || n < 0 || n > 100) return setError(t('prices.errors.coverage'))
        pctByGroup[g] = n
      }
    }
    try {
      await actions.saveInsurer.mutateAsync({
        id: insurer?.id,
        code,
        name,
        type,
        coveragePct: c,
        pctByGroup,
        active,
      })
      onClose()
    } catch (err) {
      setError(t('prices.errors.generic', { message: err instanceof Error ? err.message : '' }))
    }
  }

  return (
    <Card className="border-primary">
      <CardHeader>
        <span>
          {insurer
            ? t('prices.insurers.editTitle', { name: insurer.name })
            : t('prices.insurers.new')}
        </span>
      </CardHeader>
      <form onSubmit={submit}>
        <CardBody className="gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Field
              label={t('prices.insurers.form.name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <Field
              label={t('prices.insurers.form.code')}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="RAMA"
            />
            <Select
              label={t('prices.insurers.form.type')}
              value={type}
              onChange={(e) => setType(e.target.value as PayerType)}
            >
              {PAYER_TYPES.map((p) => (
                <option key={p} value={p}>
                  {t(`prices.insurers.types.${p}`)}
                </option>
              ))}
            </Select>
            <Field
              label={t('prices.insurers.form.coverage')}
              inputMode="numeric"
              value={coverage}
              onChange={(e) => setCoverage(e.target.value.replace(/[^\d.]/g, '').slice(0, 5))}
              required
            />
          </div>
          <span className="text-ink-2 text-[13px] font-semibold">
            {t('prices.insurers.form.byGroup')}
          </span>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {SERVICE_GROUPS.map((g) => (
              <Field
                key={g}
                label={t(`prices.groups.${g}`)}
                inputMode="numeric"
                value={byGroup[g] ?? ''}
                onChange={(e) =>
                  setByGroup((s) => ({
                    ...s,
                    [g]: e.target.value.replace(/[^\d.]/g, '').slice(0, 5),
                  }))
                }
                placeholder={`${coverage || 0}%`}
              />
            ))}
          </div>
          <label className="flex min-h-11 items-center gap-2 text-[13px] font-semibold">
            <input
              type="checkbox"
              className="accent-primary size-[18px]"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            {t('prices.insurers.form.active')}
          </label>
          <p className="text-ink-3 m-0 text-xs">{t('prices.insurers.form.publicNote')}</p>
          {error && (
            <p role="alert" className={errorBox}>
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={actions.saveInsurer.isPending}>
              {actions.saveInsurer.isPending ? t('settings.saving') : t('prices.form.save')}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('staff.form.cancel')}
            </Button>
          </div>
        </CardBody>
      </form>
    </Card>
  )
}
