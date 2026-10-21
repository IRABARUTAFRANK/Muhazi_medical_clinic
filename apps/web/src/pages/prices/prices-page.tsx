import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  Building2,
  Check,
  Copy,
  Eye,
  EyeOff,
  FolderPlus,
  Layers,
  Pencil,
  Plus,
  Receipt,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Tags,
  Trash2,
  Wrench,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  CATEGORY_IDS,
  FEATURES,
  formatNumber,
  formatRwf,
  isoDate,
  type CategoryId,
  type StaffUser,
} from '@mmc/shared'
import { tintClass, type Tint } from '@/components/dash/kit-style'
import { PageBanner } from '@/components/dash/page-banner'
import { AdjustField } from '@/components/ui/adjust-field'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Chip } from '@/components/ui/chip'
import { Field } from '@/components/ui/field'
import { Seg } from '@/components/ui/seg'
import { Select } from '@/components/ui/select'
import { StaffShell } from '@/components/staff/staff-shell'
import { allowanceAsPct, type AdjustMode } from '@/lib/adjust'
import {
  PAYER_TYPES,
  SERVICE_GROUPS,
  useCatalogueActions,
  useInsurers,
  treatmentName,
  useServiceBilling,
  useTreatments,
  type Insurer,
  type PayerType,
  type ServiceGroup,
  categoryName,
  groupOfCategory,
  useCategories,
  type Treatment,
} from '@/lib/api/catalogue'
import { suggestNames } from '@/lib/medical-glossary'
import { CatalogueTools } from './catalogue-tools'
import { CategoriesCard } from './categories-card'
import { MedicinesSection } from './medicines-section'
import { useDepartmentActions, useDepartments, type Department } from '@/lib/api/staff'
import { navForUser } from '@/lib/nav'
import { cn } from '@/lib/utils'
import { ShownList } from '@/components/ui/list-tools'

const errorBox = 'bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold'

/** Each department card gets its own colour, in this order. */
const DEPT_TINTS: Tint[] = ['teal', 'violet', 'mint', 'amber', 'coral', 'navy']
const DEPT_HEAD: Record<Tint, string> = {
  teal: 'bg-primary-tint',
  violet: 'bg-violet-bg',
  mint: 'bg-green-bg',
  amber: 'bg-amber-bg',
  coral: 'bg-red-bg',
  navy: 'bg-blue-bg',
}
const DEPT_TEXT: Record<Tint, string> = {
  teal: 'text-primary',
  violet: 'text-violet',
  mint: 'text-green',
  amber: 'text-amber',
  coral: 'text-red',
  navy: 'text-navy-ink',
}

/**
 * Manager: the treatment catalogue (what the clinic treats, the price, the discount a
 * clinician may give), with search, duplicate, show/hide, delete and bulk price changes.
 * Insurers appear only once the clinic switches insurance on (FEATURES.insurance).
 */
export function PricesPage({ user }: { user: StaffUser }) {
  const { t, i18n } = useTranslation()
  const { data: treatments = [], error: tError } = useTreatments()
  const { data: insurers = [], error: iError } = useInsurers()
  const actions = useCatalogueActions()
  const [editing, setEditing] = useState<Treatment | 'new' | null>(null)
  const [copyFrom, setCopyFrom] = useState<Treatment | null>(null)
  const [editingInsurer, setEditingInsurer] = useState<Insurer | 'new' | null>(null)
  const [query, setQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [managingCats, setManagingCats] = useState(false)
  const { data: categories = [] } = useCategories()
  const catLabel = (x: Treatment) => {
    const c = categories.find((k) => k.id === x.categoryId)
    return c ? categoryName(c, i18n.language) : t(`prices.groups.${x.group}`)
  }
  const [showHidden, setShowHidden] = useState(true)
  const [adjusting, setAdjusting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [view, setView] = useState<'dept' | 'group'>('dept')
  const [presetDept, setPresetDept] = useState<string | null>(null)
  const [newDept, setNewDept] = useState<string | null>(null)
  const [tools, setTools] = useState(false)
  // One panel at a time under the banner (they used to stack, so a second one opened out of
  // sight below the first); the page scrolls to the one opened.
  const panelsTop = useRef<HTMLDivElement>(null)
  const closePanels = () => {
    setAdjusting(false)
    setNewDept(null)
    setManagingCats(false)
    setTools(false)
  }
  const openPanel = (which: 'adjust' | 'dept' | 'cats' | 'tools', isOpen: boolean) => {
    closePanels()
    setEditing(null)
    if (isOpen) return
    if (which === 'adjust') setAdjusting(true)
    else if (which === 'dept') setNewDept('')
    else if (which === 'cats') setManagingCats(true)
    else setTools(true)
  }
  const deptOpen = newDept !== null
  const anyPanel = adjusting || deptOpen || managingCats || tools || editing !== null
  useEffect(() => {
    if (anyPanel) panelsTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [anyPanel, adjusting, deptOpen, managingCats, tools, editing])
  const { data: departments = [] } = useDepartments()
  const deptActions = useDepartmentActions()
  const today = new Date()
  const monthStart = isoDate(new Date(today.getFullYear(), today.getMonth(), 1))
  const { data: billing = {} } = useServiceBilling(monthStart, isoDate(today))

  const activeInsurers = FEATURES.insurance ? insurers.filter((i) => i.active) : []
  const q = query.trim().toLowerCase()
  const visible = treatments.filter(
    (x) =>
      (!categoryFilter || x.categoryId === categoryFilter) &&
      (showHidden || x.active) &&
      (!q ||
        `${x.nameEn} ${x.nameKin ?? ''} ${x.nameFr ?? ''} ${x.code}`.toLowerCase().includes(q)),
  )
  const shownCategories = categories.filter((c) => visible.some((x) => x.categoryId === c.id))
  const known = new Set(departments.map((d) => d.id))
  // A treatment shows in the card of every department that gives it.
  const deptsOf = (x: Treatment) => x.departmentIds.filter((id) => known.has(id))
  const filtering = !!q || !!categoryFilter
  const deptCards: { id: string; dept: Department | null; items: Treatment[] }[] = [
    ...departments.map((d) => ({
      id: d.id,
      dept: d,
      items: visible.filter((x) => deptsOf(x).includes(d.id)),
    })),
    { id: '', dept: null, items: visible.filter((x) => deptsOf(x).length === 0) },
  ].filter((c) => c.items.length > 0 || (!filtering && c.dept !== null))

  const addTo = (deptId: string | null) => {
    setCopyFrom(null)
    setPresetDept(deptId)
    closePanels()
    setEditing('new')
  }
  const createDept = () => {
    const name = (newDept ?? '').trim()
    if (name.length < 2) return
    void run(
      async () => {
        await deptActions.save.mutateAsync({ name, description: '', roles: [] })
        setNewDept(null)
      },
      t('prices.dept.created', { name }),
    )
  }

  const renderRows = (items: Treatment[]) => (
    <ShownList step={10} footerClassName="px-4 py-2" items={items}>
      {(rows) =>
        rows.map((x) => {
          const used = billing[x.id]
          return (
            <Row
              key={x.id}
              className={cn('flex-wrap gap-x-3 gap-y-1 py-2', !x.active && 'opacity-60')}
            >
              <span className="min-w-[200px] flex-1">
                <span className="text-ink block font-semibold">
                  {treatmentName(x, i18n.language)}
                </span>
                <span className="text-ink-3 text-xs">
                  {x.code}
                  {view === 'dept' ? ` · ${catLabel(x)}` : ''}
                  {view === 'group' && x.departmentNames.length > 0
                    ? ` · ${x.departmentNames.join(', ')}`
                    : ''}
                  {view === 'dept' && x.departmentNames.length > 1
                    ? ` · ${t('prices.dept.alsoIn', { count: x.departmentNames.length })}`
                    : ''}
                  {x.nameKin ? ` · ${x.nameKin}` : ''}
                  {x.nameFr ? ` · ${x.nameFr}` : ''}
                </span>
              </span>
              <span className="text-primary text-[15px] font-extrabold tabular-nums">
                {x.cashPrice == null
                  ? t('prices.noPrice')
                  : x.cashPrice === 0
                    ? t('price.free')
                    : formatRwf(x.cashPrice)}
              </span>
              {used && used.count > 0 && (
                <Chip
                  className="bg-violet-bg text-violet border-transparent"
                  title={t('prices.dept.billedTitle')}
                >
                  {t('prices.dept.billed', {
                    count: used.count,
                    amount: formatNumber(used.amount),
                  })}
                </Chip>
              )}
              {activeInsurers.map((i) =>
                x.payerPrices[i.id] != null ? (
                  <Chip key={i.id}>
                    {i.code}: {formatRwf(x.payerPrices[i.id]!)}
                  </Chip>
                ) : null,
              )}
              <Chip title={t('prices.maxDiscountTitle')}>
                {t('prices.maxDiscount', { pct: x.maxDiscountPct })}
              </Chip>
              {x.allowManualPrice && (
                <Chip title={t('prices.form.allowManualHint')}>{t('prices.typedPrice')}</Chip>
              )}
              {!x.active && <Badge tone="grey">{t('prices.inactive')}</Badge>}
              <span className="flex flex-wrap gap-1">
                <Button
                  size="sm"
                  onClick={() => {
                    closePanels()
                    setEditing(x)
                  }}
                >
                  <Pencil size={14} aria-hidden="true" />
                  {t('prices.edit')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  title={t('prices.duplicate')}
                  aria-label={t('prices.duplicate')}
                  onClick={() => {
                    setCopyFrom(x)
                    // the copy keeps every department of the original
                    setPresetDept(null)
                    closePanels()
                    setEditing('new')
                  }}
                >
                  <Copy size={14} aria-hidden="true" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  title={t(x.active ? 'prices.hide' : 'prices.show')}
                  aria-label={t(x.active ? 'prices.hide' : 'prices.show')}
                  onClick={() => toggle(x)}
                >
                  {x.active ? (
                    <EyeOff size={14} aria-hidden="true" />
                  ) : (
                    <Eye size={14} aria-hidden="true" />
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="hover:text-red"
                  title={t('prices.delete')}
                  aria-label={t('prices.delete')}
                  onClick={() => remove(x)}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </Button>
              </span>
            </Row>
          )
        })
      }
    </ShownList>
  )

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setActionError(null)
    setNotice(null)
    try {
      await fn()
      setNotice(done)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    }
  }
  const remove = (x: Treatment) => {
    if (!window.confirm(t('prices.confirmDelete', { name: x.nameEn }))) return
    void run(
      () => actions.deleteTreatment.mutateAsync(x.id),
      t('prices.deleted', { name: x.nameEn }),
    )
  }
  const toggle = (x: Treatment) =>
    void run(
      () => actions.setTreatmentActive.mutateAsync({ treatment: x, active: !x.active }),
      t(x.active ? 'prices.hidden' : 'prices.shown', { name: x.nameEn }),
    )

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="prices">
      <main className="pc:px-6 pc:pb-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <PageBanner
          icon={Receipt}
          tint="amber"
          title={t(FEATURES.insurance ? 'prices.title' : 'prices.titleCash')}
          lead={t(FEATURES.insurance ? 'prices.lead' : 'prices.leadCash')}
        >
          <Button onClick={() => openPanel('adjust', adjusting)}>
            <SlidersHorizontal size={18} aria-hidden="true" />
            {t('prices.adjust.open')}
          </Button>
          <Button onClick={() => openPanel('dept', newDept !== null)}>
            <FolderPlus size={18} aria-hidden="true" />
            {t('prices.dept.new')}
          </Button>
          <Button onClick={() => openPanel('cats', managingCats)}>
            <Tags size={18} aria-hidden="true" />
            {t('prices.cat.open')}
          </Button>
          <Button onClick={() => openPanel('tools', tools)}>
            <Wrench size={18} aria-hidden="true" />
            {t('prices.tools.open')}
          </Button>
          <Button variant="primary" onClick={() => addTo(null)}>
            <Plus size={18} aria-hidden="true" />
            {t('prices.newTreatment')}
          </Button>
        </PageBanner>

        <div ref={panelsTop} className="-mt-2 scroll-mt-4" aria-hidden="true" />
        {managingCats && (
          <CategoriesCard
            treatments={treatments}
            onDone={(text) => {
              setNotice(text)
              setActionError(null)
            }}
            onClose={() => setManagingCats(false)}
          />
        )}

        {tools && (
          <CatalogueTools
            departments={departments}
            onDone={(text) => {
              setNotice(text)
              setActionError(null)
            }}
            onClose={() => setTools(false)}
          />
        )}

        {newDept !== null && (
          <Card>
            <CardBody className="flex-row flex-wrap items-end gap-3">
              <Field
                label={t('prices.dept.name')}
                value={newDept}
                autoFocus
                placeholder={t('prices.dept.namePh')}
                onChange={(e) => setNewDept(e.target.value)}
                wrapperClassName="min-w-[240px] flex-1"
              />
              <Button
                variant="primary"
                disabled={newDept.trim().length < 2 || deptActions.save.isPending}
                onClick={createDept}
              >
                <FolderPlus size={16} aria-hidden="true" />
                {t('prices.dept.create')}
              </Button>
              <Button variant="ghost" onClick={() => setNewDept(null)}>
                {t('staff.form.cancel')}
              </Button>
              <p className="text-ink-3 m-0 basis-full text-[13px]">{t('prices.dept.newHint')}</p>
            </CardBody>
          </Card>
        )}

        {(tError || iError || actionError) && (
          <p role="alert" className={errorBox}>
            {actionError ?? (tError ?? iError)?.message}
          </p>
        )}
        {notice && (
          <p
            role="status"
            className="bg-green-bg text-green m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
          >
            {notice}
          </p>
        )}

        {adjusting && (
          <AdjustPricesCard
            onClose={() => setAdjusting(false)}
            onDone={(n) => {
              setAdjusting(false)
              setNotice(t('prices.adjust.done', { count: n }))
            }}
          />
        )}

        {editing && (
          <TreatmentForm
            key={editing === 'new' ? `new-${copyFrom?.id ?? ''}-${presetDept ?? ''}` : editing.id}
            treatment={editing === 'new' ? null : editing}
            copyFrom={editing === 'new' ? copyFrom : null}
            insurers={activeInsurers}
            departments={departments}
            presetDepartment={editing === 'new' ? presetDept : null}
            onClose={() => {
              setEditing(null)
              setCopyFrom(null)
              setPresetDept(null)
            }}
          />
        )}

        {/* Search and filter */}
        <Card>
          <CardBody className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[2fr_1fr_auto] lg:grid-cols-[2fr_1fr_auto_auto]">
            <Field
              label={t('prices.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('prices.searchPh')}
            />
            <Select
              label={t('prices.form.group')}
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
            >
              <option value="">{t('prices.allGroups')}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {categoryName(c, i18n.language)}
                </option>
              ))}
            </Select>
            <label className="flex min-h-11 items-center gap-2 text-[13px] font-semibold">
              <input
                type="checkbox"
                className="accent-primary size-[18px]"
                checked={showHidden}
                onChange={(e) => setShowHidden(e.target.checked)}
              />
              {t('prices.showHidden')}
            </label>
            <Seg
              label={t('prices.dept.viewBy')}
              value={view}
              onChange={setView}
              options={[
                { value: 'dept', label: t('prices.dept.byDept') },
                { value: 'group', label: t('prices.dept.byType') },
              ]}
            />
          </CardBody>
        </Card>

        {visible.length === 0 && (
          <Card>
            <CardBody>
              <p className="text-ink-3 m-0 text-[13px]">
                <Search size={14} aria-hidden="true" className="mr-1 inline" />
                {t('prices.noMatch')}
              </p>
            </CardBody>
          </Card>
        )}

        {/* By department: every department with its services and prices, then those without one */}
        {view === 'dept' &&
          deptCards.map((c, n) => {
            const tint = DEPT_TINTS[n % DEPT_TINTS.length]!
            const prices = c.items
              .map((x) => x.cashPrice)
              .filter((v): v is number => v != null && v > 0)
            const billed = c.items.reduce(
              (acc, x) => ({
                count: acc.count + (billing[x.id]?.count ?? 0),
                amount: acc.amount + (billing[x.id]?.amount ?? 0),
              }),
              { count: 0, amount: 0 },
            )
            return (
              <Card key={c.id || 'none'} className="overflow-hidden">
                <div className={cn('flex flex-wrap items-center gap-3 px-4 py-3', DEPT_HEAD[tint])}>
                  <span
                    className={cn(
                      'inline-flex size-10 flex-none items-center justify-center rounded-xl',
                      tintClass[tint],
                      'bg-card',
                    )}
                  >
                    {c.dept ? (
                      <Building2 size={20} aria-hidden="true" />
                    ) : (
                      <Layers size={20} aria-hidden="true" />
                    )}
                  </span>
                  <span className="min-w-[180px] flex-1">
                    <span className={cn('block text-[17px] font-extrabold', DEPT_TEXT[tint])}>
                      {c.dept?.name ?? t('prices.dept.none')}
                    </span>
                    <span className="text-ink-2 block text-[13px]">
                      {c.dept
                        ? c.dept.description ||
                          t('prices.dept.servicesCount', { count: c.items.length })
                        : t('prices.dept.noneHint')}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Chip className="bg-card">
                      {t('prices.dept.servicesCount', { count: c.items.length })}
                    </Chip>
                    {prices.length > 0 && (
                      <Chip className="bg-card">
                        {Math.min(...prices) === Math.max(...prices)
                          ? formatRwf(prices[0]!)
                          : `${formatRwf(Math.min(...prices))} – ${formatNumber(Math.max(...prices))}`}
                      </Chip>
                    )}
                    <Chip className="bg-card" title={t('prices.dept.billedTitle')}>
                      {t('prices.dept.month', { amount: formatRwf(billed.amount) })}
                    </Chip>
                  </span>
                  <Button size="sm" variant="primary" onClick={() => addTo(c.dept?.id ?? null)}>
                    <Plus size={14} aria-hidden="true" />
                    {t('prices.dept.add')}
                  </Button>
                </div>
                {c.items.length === 0 ? (
                  <p className="text-ink-3 m-0 px-4 py-3 text-[13px]">{t('prices.dept.empty')}</p>
                ) : (
                  renderRows(c.items)
                )}
              </Card>
            )
          })}
        {view === 'dept' && departments.length === 0 && (
          <Card>
            <CardBody className="flex-row items-center gap-3">
              <Building2 size={18} aria-hidden="true" className="text-violet flex-none" />
              <p className="text-ink-2 m-0 text-[13px]">{t('prices.dept.noDepartments')}</p>
            </CardBody>
          </Card>
        )}

        {/* By type of treatment */}
        {view === 'group' &&
          shownCategories.map((c) => (
            <Card key={c.id}>
              <CardHeader>
                <span className="inline-flex items-center gap-2">
                  <Tag size={16} aria-hidden="true" />
                  {categoryName(c, i18n.language)}
                  {c.kind !== 'treatment' && <Chip>{t(`prices.cat.kinds.${c.kind}`)}</Chip>}
                </span>
                <span className="text-ink-3 text-xs">
                  {visible.filter((x) => x.categoryId === c.id).length}
                </span>
              </CardHeader>
              {renderRows(visible.filter((x) => x.categoryId === c.id))}
            </Card>
          ))}

        {/* Medicines and supplies with their price */}
        <MedicinesSection onNotice={setNotice} />

        {/* Insurers: only once the clinic works with insurers */}
        {FEATURES.insurance ? (
          <InsurersSection
            insurers={insurers}
            activeCount={activeInsurers.length}
            editingInsurer={editingInsurer}
            setEditingInsurer={setEditingInsurer}
            onDelete={(i) => {
              if (!window.confirm(t('prices.insurers.confirmDelete', { name: i.name }))) return
              void run(
                () => actions.deleteInsurer.mutateAsync(i.id),
                t('prices.deleted', { name: i.name }),
              )
            }}
          />
        ) : (
          <Card>
            <CardBody className="flex-row items-center gap-3">
              <ShieldCheck size={18} aria-hidden="true" className="text-ink-3 flex-none" />
              <p className="text-ink-2 m-0 text-[13px]">{t('prices.insurers.parked')}</p>
            </CardBody>
          </Card>
        )}
      </main>
    </StaffShell>
  )
}

function InsurersSection({
  insurers,
  activeCount,
  editingInsurer,
  setEditingInsurer,
  onDelete,
}: {
  insurers: Insurer[]
  activeCount: number
  editingInsurer: Insurer | 'new' | null
  setEditingInsurer: (i: Insurer | 'new' | null) => void
  onDelete: (i: Insurer) => void
}) {
  const { t } = useTranslation()
  return (
    <>
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
            {t('prices.insurers.activeCount', { count: activeCount })}
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
            <Button
              size="sm"
              variant="ghost"
              className="hover:text-red"
              title={t('prices.delete')}
              aria-label={t('prices.delete')}
              onClick={() => onDelete(i)}
            >
              <Trash2 size={14} aria-hidden="true" />
            </Button>
          </Row>
        ))}
      </Card>
    </>
  )
}

/* ---------------------------------------------------------------- bulk price change */

function AdjustPricesCard({
  onClose,
  onDone,
}: {
  onClose: () => void
  onDone: (changed: number) => void
}) {
  const { t, i18n } = useTranslation()
  const actions = useCatalogueActions()
  const { data: treatments = [] } = useTreatments()
  const { data: categories = [] } = useCategories()
  const [category, setCategory] = useState('')
  const [mode, setMode] = useState<'multiply' | 'percent' | 'amount'>('multiply')
  const [value, setValue] = useState('')
  const [round, setRound] = useState(100)
  const [error, setError] = useState<string | null>(null)

  const v = Number(value.replace(',', '.'))
  const valid =
    value.trim() !== '' &&
    Number.isFinite(v) &&
    (mode === 'multiply' ? v > 0 && v <= 10 : mode === 'percent' ? v > -100 && v <= 900 : true)
  const affected = treatments.filter(
    (x) => (!category || x.categoryId === category) && x.cashPrice != null && x.cashPrice > 0,
  )
  const apply = (p: number) => {
    const raw = mode === 'multiply' ? p * v : mode === 'percent' ? (p * (100 + v)) / 100 : p + v
    return Math.max(0, Math.round(raw / round) * round)
  }
  const example = affected[0]

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!valid) return setError(t('prices.adjust.invalid'))
    if (!window.confirm(t('prices.adjust.confirm', { count: affected.length }))) return
    try {
      const n = await actions.adjustPrices.mutateAsync({
        category: category || null,
        mode,
        value: v,
        round,
      })
      onDone(n)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Card className="border-primary">
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          <SlidersHorizontal size={16} aria-hidden="true" />
          {t('prices.adjust.title')}
        </span>
      </CardHeader>
      <form onSubmit={submit}>
        <CardBody className="gap-3">
          <p className="text-ink-2 m-0 text-[13px]">{t('prices.adjust.lead')}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Select
              label={t('prices.adjust.which')}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">{t('prices.allGroups')}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {categoryName(c, i18n.language)}
                </option>
              ))}
            </Select>
            <Select
              label={t('prices.adjust.how')}
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
            >
              <option value="multiply">{t('prices.adjust.modes.multiply')}</option>
              <option value="percent">{t('prices.adjust.modes.percent')}</option>
              <option value="amount">{t('prices.adjust.modes.amount')}</option>
            </Select>
            <Field
              label={t(`prices.adjust.value.${mode}`)}
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={mode === 'multiply' ? '1.1' : mode === 'percent' ? '10' : '500'}
              required
            />
            <Select
              label={t('prices.adjust.round')}
              value={round}
              onChange={(e) => setRound(Number(e.target.value))}
            >
              {[1, 10, 50, 100, 500].map((r) => (
                <option key={r} value={r}>
                  {r === 1 ? t('prices.adjust.noRound') : `${r} RWF`}
                </option>
              ))}
            </Select>
          </div>
          {valid && example && example.cashPrice != null && (
            <p className="text-ink-2 m-0 text-[13px]">
              {t('prices.adjust.preview', {
                count: affected.length,
                name: example.nameEn,
                from: formatRwf(example.cashPrice),
                to: formatRwf(apply(example.cashPrice)),
              })}
            </p>
          )}
          {error && (
            <p role="alert" className={errorBox}>
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={actions.adjustPrices.isPending}>
              {t('prices.adjust.apply')}
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

/* ---------------------------------------------------------------- treatment form */

function TreatmentForm({
  treatment,
  copyFrom,
  insurers,
  departments,
  presetDepartment,
  onClose,
}: {
  treatment: Treatment | null
  copyFrom: Treatment | null
  insurers: Insurer[]
  departments: Department[]
  /** "Add a service" from a department card places the new service there. */
  presetDepartment: string | null
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const actions = useCatalogueActions()
  const base = treatment ?? copyFrom
  const [nameEn, setNameEn] = useState(
    treatment?.nameEn ?? (copyFrom ? t('prices.copyOf', { name: copyFrom.nameEn }) : ''),
  )
  const [nameKin, setNameKin] = useState(base?.nameKin ?? '')
  const [nameFr, setNameFr] = useState(base?.nameFr ?? '')
  // Other-language names follow the English one until the user edits them.
  const [kinTouched, setKinTouched] = useState(!!base?.nameKin)
  const [frTouched, setFrTouched] = useState(!!base?.nameFr)
  const [suggested, setSuggested] = useState(false)
  const { data: categories = [] } = useCategories()
  const [categoryId, setCategoryId] = useState<string>(
    base?.categoryId ?? categories.find((c) => c.baseGroup === 'consultation')?.id ?? '',
  )
  const chosenCategory =
    categories.find((c) => c.id === categoryId) ?? categories.find((c) => c.kind === 'treatment')
  const [category, setCategory] = useState<CategoryId | ''>(base?.bookingCategory ?? '')
  const [price, setPrice] = useState(base?.cashPrice != null ? String(base.cashPrice) : '')
  const [discountMode, setDiscountMode] = useState<AdjustMode>('pct')
  const [maxDiscount, setMaxDiscount] = useState(String(base?.maxDiscountPct ?? 0))
  const [allowManual, setAllowManual] = useState(base?.allowManualPrice ?? false)
  const [active, setActive] = useState(base?.active ?? true)
  const [depts, setDepts] = useState<string[]>(
    treatment?.departmentIds ??
      (presetDepartment ? [presetDepartment] : (copyFrom?.departmentIds ?? [])),
  )
  const toggleDept = (id: string) =>
    setDepts((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]))
  const [payerPrices, setPayerPrices] = useState<Record<string, string>>(
    Object.fromEntries(
      insurers.map((i) => [
        i.id,
        base?.payerPrices[i.id] != null ? String(base.payerPrices[i.id]) : '',
      ]),
    ),
  )
  const [error, setError] = useState<string | null>(null)

  const p = Number(price)
  const pct = allowanceAsPct(discountMode, maxDiscount, Number.isFinite(p) ? p : 0)

  const onEnglish = (v: string) => {
    setNameEn(v)
    const s = suggestNames(v)
    if (!kinTouched) setNameKin(s?.rw ?? '')
    if (!frTouched) setNameFr(s?.fr ?? '')
    setSuggested(!!s && (!kinTouched || !frTouched))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!nameEn.trim()) return setError(t('prices.errors.name'))
    if (!Number.isFinite(p) || p < 0) return setError(t('prices.errors.price'))
    if (pct == null) return setError(t('prices.errors.discount'))
    try {
      await actions.saveTreatment.mutateAsync({
        id: treatment?.id,
        nameEn,
        nameKin,
        nameFr,
        group: chosenCategory ? groupOfCategory(chosenCategory) : 'other',
        categoryId: chosenCategory?.id,
        bookingCategory: category || null,
        cashPrice: Math.round(p),
        maxDiscountPct: pct,
        allowManualPrice: allowManual,
        active,
        payerPrices,
        departmentIds: depts,
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
            : presetDepartment
              ? t('prices.dept.addTo', {
                  name: departments.find((d) => d.id === presetDepartment)?.name ?? '',
                })
              : t('prices.newTreatment')}
        </span>
      </CardHeader>
      <form onSubmit={submit}>
        <CardBody className="gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field
              label={t('prices.form.nameEn')}
              value={nameEn}
              onChange={(e) => onEnglish(e.target.value)}
              placeholder={t('prices.form.namePh')}
              required
            />
            <Field
              label={t('prices.form.nameKin')}
              value={nameKin}
              onChange={(e) => {
                setNameKin(e.target.value)
                setKinTouched(true)
              }}
            />
            <Field
              label={t('prices.form.nameFr')}
              value={nameFr}
              onChange={(e) => {
                setNameFr(e.target.value)
                setFrTouched(true)
              }}
            />
          </div>
          {suggested && (
            <p className="text-ink-3 m-0 -mt-1 inline-flex items-center gap-1 text-xs">
              <Sparkles size={12} aria-hidden="true" />
              {t('prices.form.suggested')}
            </p>
          )}
          <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend className="text-ink-2 mb-1 text-[13px] font-semibold">
              {t('prices.dept.fieldMany')}
            </legend>
            {departments.length === 0 ? (
              <p className="text-ink-3 m-0 text-xs">{t('prices.dept.noDepartments')}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {departments.map((d) => {
                  const on = depts.includes(d.id)
                  return (
                    <button
                      key={d.id}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      onClick={() => toggleDept(d.id)}
                      className={cn(
                        'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold',
                        on
                          ? 'border-primary bg-primary text-white'
                          : 'border-border bg-card text-ink-2 hover:bg-hover',
                      )}
                    >
                      {on ? (
                        <Check size={14} aria-hidden="true" />
                      ) : (
                        <Building2 size={14} aria-hidden="true" />
                      )}
                      {d.name}
                    </button>
                  )
                })}
              </div>
            )}
            <p className="text-ink-3 m-0 text-xs">{t('prices.dept.fieldHint')}</p>
          </fieldset>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Select
              label={t('prices.form.group')}
              value={chosenCategory?.id ?? ''}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              {categories
                .filter((c) => c.kind !== 'bed' || c.id === base?.categoryId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {categoryName(c, i18n.language)}
                    {c.kind !== 'treatment' ? ` · ${t(`prices.cat.kinds.${c.kind}`)}` : ''}
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
            <AdjustField
              label={t('prices.form.maxDiscount')}
              mode={discountMode}
              modes={['pct', 'rwf', 'x']}
              value={maxDiscount}
              onMode={setDiscountMode}
              onChange={setMaxDiscount}
              invalid={pct == null}
              hint={
                pct == null
                  ? t('prices.errors.discount')
                  : pct > 0 && p > 0
                    ? t('prices.form.maxDiscountIs', {
                        pct,
                        amount: formatRwf(Math.round((p * pct) / 100)),
                      })
                    : t('prices.form.maxDiscountNone')
              }
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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="border-border flex items-start gap-3 rounded-xl border p-3">
              <input
                type="checkbox"
                className="accent-primary mt-0.5 size-[18px] flex-none"
                checked={allowManual}
                onChange={(e) => setAllowManual(e.target.checked)}
              />
              <span>
                <span className="block text-[13px] font-semibold">
                  {t('prices.form.allowManual')}
                </span>
                <span className="text-ink-3 block text-xs">{t('prices.form.allowManualHint')}</span>
              </span>
            </label>
            <label className="border-border flex items-start gap-3 rounded-xl border p-3">
              <input
                type="checkbox"
                className="accent-primary mt-0.5 size-[18px] flex-none"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              <span>
                <span className="block text-[13px] font-semibold">{t('prices.form.active')}</span>
                <span className="text-ink-3 block text-xs">{t('prices.form.activeHint')}</span>
              </span>
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
