import { useRef, useState, type FormEvent } from 'react'
import {
  BookCheck,
  Check,
  FileSpreadsheet,
  History,
  ListChecks,
  Pencil,
  Plus,
  Maximize2,
  ShieldCheck,
  Table2,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatNumber, formatRwf, isoDate } from '@mmc/shared'
import {
  headerBand,
  tableCell,
  tableHead,
  tableRow,
  tileClass,
  type Hue,
} from '@/components/dash/kit-style'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Chip } from '@/components/ui/chip'
import { Field } from '@/components/ui/field'
import { ShownList } from '@/components/ui/list-tools'
import { Seg } from '@/components/ui/seg'
import { Select } from '@/components/ui/select'
import { SidePanel } from '@/components/ui/side-panel'
import {
  PAYER_TYPES,
  payerBodyOf,
  SERVICE_GROUPS,
  useCatalogueActions,
  type Insurer,
  type PayerType,
  type ServiceGroup,
} from '@/lib/api/catalogue'
import {
  NOT_LISTED_RULES,
  useInsurerTariff,
  useInsurerTariffActions,
  type NotListedRule,
  type TariffList,
  type TariffPreview,
  type TariffRow,
} from '@/lib/api/insurers'
import { useConfirm } from '@/lib/confirm'
import { readTariffFile, TariffFileError, type ParsedTariffFile } from '@/lib/tariff-file'
import { DOCUMENT_ACCEPT } from '@/lib/document-grids'
import { cn } from '@/lib/utils'

const errorBox =
  'border-red/30 bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[14px] font-medium'
/** The form opens in a side panel; the panel's footer submits it by this id. */
const INSURER_FORM = 'insurer-form'
/** Every kind of file a price list may come in (Excel, CSV, PDF, Word, OpenDocument, a web page). */
const ACCEPT = DOCUMENT_ACCEPT

/** "2026-06-01" → 01/06/2026 (a calendar day, no time zone shift). */
const day = (iso: string) => (iso ? formatDate(new Date(`${iso.slice(0, 10)}T00:00:00`)) : '')
const price = (n: number | null | undefined) => (n == null ? '—' : formatRwf(n))

const switchClass = (on: boolean, disabled: boolean) =>
  cn(
    'relative inline-flex h-6 w-11 flex-none items-center rounded-full border transition-colors',
    on ? 'border-primary bg-primary' : 'border-border bg-hover',
    disabled && 'cursor-not-allowed opacity-50',
  )
const knobClass = (on: boolean) =>
  cn(
    'bg-card absolute top-0.5 size-[18px] rounded-full shadow transition-transform',
    on ? 'translate-x-[22px]' : 'translate-x-0.5',
  )

/** A labelled on/off switch (the insurer is active, it follows the official list). */
function Switch({
  on,
  label,
  hint,
  disabled,
  onChange,
}: {
  on: boolean
  label: string
  hint?: string
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="flex min-w-0 items-start gap-3 text-left"
    >
      <span className={switchClass(on, !!disabled)}>
        <span className={knobClass(on)} />
      </span>
      <span className="min-w-0">
        <span className="text-ink block text-[14px] font-semibold">{label}</span>
        {hint && <span className="text-ink-3 block text-[13px]">{hint}</span>}
      </span>
    </button>
  )
}

/**
 * Prices › Insurers (manager): the insurers the clinic works with. Each has a card with its
 * switches (active, follows the official medicine list, what to do with a line it has no price
 * for), its coverage, and its TARIFF: every treatment and medicine with the cash price, the
 * insurer's price and where it comes from, the coverage of the line and the patient / insurer
 * split; a price is edited in place, a whole list is uploaded (Excel or CSV, checked first) or
 * started from a date, and the earlier lists are kept.
 */
export function InsurersSection({
  insurers,
  onNotice,
  onError,
}: {
  insurers: Insurer[]
  onNotice: (text: string) => void
  onError: (text: string | null) => void
}) {
  const { t } = useTranslation()
  const actions = useCatalogueActions()
  const confirm = useConfirm()
  const [editing, setEditing] = useState<Insurer | 'new' | null>(null)
  const active = insurers.filter((i) => i.active)

  const run = async (fn: () => Promise<unknown>, done: string) => {
    onError(null)
    try {
      await fn()
      onNotice(done)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }
  const remove = async (i: Insurer) => {
    if (
      !(await confirm({
        title: t('confirm.prices.deleteInsurerTitle', { name: i.name }),
        body: t('confirm.prices.deleteInsurerBody'),
        confirmLabel: t('confirm.prices.deleteYes'),
        tone: 'danger',
      }))
    )
      return
    void run(() => actions.deleteInsurer.mutateAsync(i.id), t('prices.deleted', { name: i.name }))
  }

  return (
    <>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <div className="min-w-[min(260px,100%)] flex-1">
          <h2 className="m-0 text-[16px] font-semibold">{t('prices.insurers.title')}</h2>
          <p className="text-ink-2 m-0 mt-1 max-w-[720px]">{t('prices.insurers.lead')}</p>
          <p className="text-ink-3 m-0 mt-1 max-w-[720px] text-[13px]">{t('prices.tariff.lead')}</p>
        </div>
        <span className="text-ink-3 text-xs">
          {t('prices.insurers.activeCount', { count: active.length })}
        </span>
        <Button onClick={() => setEditing('new')}>
          <Plus size={18} aria-hidden="true" />
          {t('prices.insurers.new')}
        </Button>
      </div>

      {editing && (
        <InsurerForm
          key={editing === 'new' ? 'new' : editing.id}
          insurer={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}

      {insurers.length === 0 && (
        <Card>
          <CardBody>
            <p className="text-ink-3 m-0 text-[13px]">{t('prices.insurers.none')}</p>
          </CardBody>
        </Card>
      )}
      {insurers.map((i) => (
        <InsurerCard
          key={i.id}
          insurer={i}
          onEdit={() => setEditing(i)}
          onDelete={() => void remove(i)}
          run={run}
        />
      ))}
    </>
  )
}

/* ---------------------------------------------------------------- one insurer */

function InsurerCard({
  insurer,
  onEdit,
  onDelete,
  run,
}: {
  insurer: Insurer
  onEdit: () => void
  onDelete: () => void
  run: (fn: () => Promise<unknown>, done: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const actions = useCatalogueActions()
  const confirm = useConfirm()
  /** The tariff opens in its own wide window (it does not mix with the page). */
  const [open, setOpen] = useState(false)

  /** One switch or the rule changed: the insurer is saved with everything else as it is. */
  const save = (
    patch: Partial<Pick<Insurer, 'active' | 'followsReferenceList' | 'notListedRule'>>,
    done: string,
  ) =>
    run(
      () =>
        actions.saveInsurer.mutateAsync({
          id: insurer.id,
          code: insurer.code,
          name: insurer.name,
          type: insurer.type,
          coveragePct: insurer.coveragePct,
          pctByGroup: insurer.pctByGroup,
          active: insurer.active,
          followsReferenceList: insurer.followsReferenceList,
          notListedRule: insurer.notListedRule,
          ...patch,
        }),
      done,
    )
  const toggleActive = async () => {
    const k = insurer.active ? 'confirm.prices.insurerOff' : 'confirm.prices.insurerOn'
    if (
      !(await confirm({
        title: t(`${k}.title`, { name: insurer.name }),
        body: t(`${k}.body`),
        confirmLabel: t(`${k}.yes`),
        tone: insurer.active ? 'danger' : 'primary',
      }))
    )
      return
    void save(
      { active: !insurer.active },
      t(insurer.active ? 'prices.insurers.nowOff' : 'prices.insurers.nowOn', {
        name: insurer.name,
      }),
    )
  }
  const toggleFollows = async () => {
    const k = insurer.followsReferenceList
      ? 'confirm.prices.followsOff'
      : 'confirm.prices.followsOn'
    if (
      !(await confirm({
        title: t(`${k}.title`, { name: insurer.name }),
        body: t(`${k}.body`),
        confirmLabel: t('confirm.prices.saveYes'),
      }))
    )
      return
    void save(
      { followsReferenceList: !insurer.followsReferenceList },
      t('prices.insurers.saved', { name: insurer.name }),
    )
  }
  const chooseRule = async (rule: NotListedRule) => {
    if (rule === insurer.notListedRule) return
    if (
      !(await confirm({
        title: t('confirm.prices.ruleTitle', {
          name: insurer.name,
          rule: t(`prices.tariff.rules.${rule}`),
        }),
        body: t(`prices.tariff.rulesHint.${rule}`, { name: insurer.name }),
        confirmLabel: t('confirm.prices.saveYes'),
      }))
    )
      return
    void save({ notListedRule: rule }, t('prices.insurers.saved', { name: insurer.name }))
  }

  return (
    <Card className={cn(!insurer.active && 'opacity-80')}>
      <CardHeader icon={ShieldCheck} className={headerBand(insurer.active ? 'navy' : 'grey')}>
        <span className="min-w-0 flex-1">
          <span className="block">{insurer.name}</span>
          <span className="text-ink-3 block text-xs font-normal">
            {insurer.code} · {t(`prices.insurers.types.${insurer.type}`)}
          </span>
        </span>
        {insurer.active ? (
          <Badge tone="green">{t('prices.insurers.active')}</Badge>
        ) : (
          <Badge tone="grey">{t('prices.insurers.inactive')}</Badge>
        )}
        <Button size="sm" onClick={onEdit}>
          <Pencil size={14} aria-hidden="true" />
          {t('prices.edit')}
        </Button>
        <Button
          size="sm"
          variant="tint-coral"
          title={t('prices.delete')}
          aria-label={t('prices.delete')}
          onClick={onDelete}
        >
          <Trash2 size={14} aria-hidden="true" />
        </Button>
      </CardHeader>
      <CardBody className="gap-4">
        {/* the switches and the coverage */}
        <div className="grid grid-cols-1 gap-x-6 gap-y-3 md:grid-cols-2">
          <Switch
            on={insurer.active}
            label={t('prices.insurers.form.active')}
            hint={t('prices.tariff.activeHint')}
            disabled={actions.saveInsurer.isPending}
            onChange={() => void toggleActive()}
          />
          <Switch
            on={insurer.followsReferenceList}
            label={t('prices.tariff.followsList')}
            hint={t('prices.tariff.followsListHint')}
            disabled={actions.saveInsurer.isPending}
            onChange={() => void toggleFollows()}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ink font-semibold tabular-nums">
            {t('prices.insurers.covers', { pct: insurer.coveragePct })}
          </span>
          {Object.entries(insurer.pctByGroup).map(([g, pct]) => (
            <Chip key={g}>
              {t(`prices.groups.${g}`)}: {pct}%
            </Chip>
          ))}
          <span className="text-ink-3 text-[13px]">{t('prices.tariff.coversHint')}</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-ink-2 text-[13px] font-semibold">
            {t('prices.tariff.notListed')}
          </span>
          <Seg
            label={t('prices.tariff.notListed')}
            size="sm"
            value={insurer.notListedRule}
            onChange={(v) => void chooseRule(v)}
            options={NOT_LISTED_RULES.map((r) => ({
              value: r,
              label: t(`prices.tariff.rules.${r}`),
            }))}
          />
          <span className="text-ink-3 text-[13px]">
            {t(`prices.tariff.rulesHint.${insurer.notListedRule}`, { name: insurer.name })}
          </span>
        </div>

        {/* the tariff: in its own wide window */}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="tint-blue" onClick={() => setOpen(true)}>
            <Maximize2 size={16} aria-hidden="true" />
            {t('prices.tariff.show', { name: insurer.name })}
          </Button>
          <span className="text-ink-3 text-[13px]">{t('prices.tariff.showHint')}</span>
        </div>
      </CardBody>
      {open && <TariffWindow insurer={insurer} onClose={() => setOpen(false)} />}
    </Card>
  )
}

/* ---------------------------------------------------------------- the tariff window */

type TariffTab = 'prices' | 'upload' | 'history'

/**
 * An insurer's tariff in its own wide window over the page (not inside the page, where it mixed
 * with everything else): every treatment and medicine with the price the insurer pays, where it
 * comes from, the coverage and the two shares (search, kind, its own prices only, edit in place);
 * the upload of its price list; its earlier lists — one tab each. What is saved is said at the top
 * of the window.
 */
function TariffWindow({ insurer, onClose }: { insurer: Insurer; onClose: () => void }) {
  const { t } = useTranslation()
  const { data: tariff, error, isLoading } = useInsurerTariff(insurer.id)
  const [tab, setTab] = useState<TariffTab>('prices')
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  /** Runs a change and says in the window what was done (or the refusal). */
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setMessage(null)
    try {
      await fn()
      setMessage({ ok: true, text: done })
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) })
    }
  }
  const lists = tariff?.lists ?? []
  return (
    <SidePanel
      open
      onClose={onClose}
      hue="blue"
      icon={Table2}
      // wide: the tariff's six columns side by side
      className="w-[1280px]"
      padded={false}
      title={t('prices.tariff.windowTitle', { name: insurer.name })}
      subtitle={[
        t(`prices.insurers.types.${insurer.type}`),
        t('prices.insurers.covers', { pct: insurer.coveragePct }),
        lists.length > 0 ? t('prices.tariff.listsCount', { count: lists.length }) : null,
      ]
        .filter(Boolean)
        .join(' · ')}
    >
      <div className="border-border bg-card sticky top-0 z-2 flex flex-col gap-2 border-b px-4 py-3">
        <Seg
          label={t('prices.tariff.windowTitle', { name: insurer.name })}
          value={tab}
          onChange={(v) => {
            setTab(v)
            setMessage(null)
          }}
          options={[
            {
              value: 'prices',
              label: t('prices.tariff.tabs.prices', {
                n: formatNumber(tariff?.rows.length ?? 0),
              }),
            },
            { value: 'upload', label: t('prices.tariff.tabs.upload') },
            {
              value: 'history',
              label: t('prices.tariff.tabs.history', { n: formatNumber(lists.length) }),
            },
          ]}
          className="self-start"
        />
        {message && (
          <p
            role={message.ok ? 'status' : 'alert'}
            className={
              message.ok
                ? 'border-green/30 bg-green-bg text-green m-0 rounded-md border px-3 py-2 text-[14px] font-medium'
                : errorBox
            }
          >
            {message.text}
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className={cn(errorBox, 'mx-4 mt-3')}>
          {error.message}
        </p>
      )}
      {isLoading && <p className="text-ink-3 m-0 px-4 py-3">{t('prices.lists.loading')}</p>}
      {tariff && tab === 'prices' && <TariffTable insurer={insurer} rows={tariff.rows} run={run} />}
      {tariff && tab === 'upload' && <ImportPanel insurer={insurer} lists={lists} run={run} />}
      {tariff &&
        tab === 'history' &&
        (lists.length > 0 ? (
          <ListsHistory lists={lists} />
        ) : (
          <p className="text-ink-3 m-0 px-4 py-3 text-[14px]">{t('prices.tariff.noHistory')}</p>
        ))}
    </SidePanel>
  )
}

/* ---------------------------------------------------------------- the tariff table */

const SOURCE_TONE: Record<TariffRow['source'], 'green' | 'blue' | 'yellow' | 'grey' | 'red'> = {
  tariff: 'green',
  reference: 'blue',
  cash: 'yellow',
  none: 'grey',
  // 0134: the insurer's exception: not covered, or covered with its approval
  excluded: 'red',
  preauth: 'yellow',
}

function TariffTable({
  insurer,
  rows,
  run,
}: {
  insurer: Insurer
  rows: TariffRow[]
  run: (fn: () => Promise<unknown>, done: string) => Promise<void>
}) {
  const { t, i18n } = useTranslation()
  const actions = useInsurerTariffActions()
  const confirm = useConfirm()
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'all' | 'service' | 'item'>('all')
  const [ownOnly, setOwnOnly] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const name = (r: TariffRow) =>
    (i18n.language === 'fr' ? r.nameFr : i18n.language === 'rw' ? r.nameKin : null) || r.name
  const q = query.trim().toLowerCase()
  const shown = rows.filter(
    (r) =>
      (kind === 'all' || r.kind === kind) &&
      (!ownOnly || r.source === 'tariff') &&
      (!q || `${r.name} ${r.nameFr ?? ''} ${r.nameKin ?? ''} ${r.code}`.toLowerCase().includes(q)),
  )
  const own = rows.filter((r) => r.source === 'tariff').length
  const key = (r: TariffRow) => `${r.kind}:${r.id}`

  const start = (r: TariffRow) => {
    setEditing(key(r))
    setDraft(r.source === 'tariff' && r.price != null ? String(r.price) : '')
  }
  const save = async (r: TariffRow) => {
    const v = draft.trim()
    const n = v === '' ? null : Number(v.replace(/[\s,]/g, ''))
    if (n != null && (!Number.isFinite(n) || n < 0)) return
    if (
      !(await confirm({
        title:
          n == null
            ? t('confirm.prices.priceRemoveTitle', { item: name(r), name: insurer.name })
            : t('confirm.prices.priceTitle', {
                item: name(r),
                name: insurer.name,
                price: formatRwf(n),
              }),
        body: t('confirm.prices.priceBody'),
        confirmLabel: t('confirm.prices.saveYes'),
      }))
    )
      return
    await run(
      () =>
        actions.setPrice.mutateAsync({
          payerId: insurer.id,
          serviceId: r.kind === 'service' ? r.id : null,
          itemId: r.kind === 'item' ? r.id : null,
          price: n,
        }),
      n == null
        ? t('prices.tariff.priceRemoved', { item: name(r), name: insurer.name })
        : t('prices.tariff.priceSaved', { item: name(r), name: insurer.name, price: formatRwf(n) }),
    )
    setEditing(null)
  }

  return (
    <div className="border-border flex flex-col gap-3 border-t px-4 py-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label={t('prices.tariff.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('prices.tariff.searchPh')}
          wrapperClassName="min-w-[min(240px,100%)] flex-1"
        />
        <Seg
          label={t('prices.tariff.kind')}
          size="sm"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: t('prices.tariff.kinds.all') },
            { value: 'service', label: t('prices.tariff.kinds.service') },
            { value: 'item', label: t('prices.tariff.kinds.item') },
          ]}
        />
        <label className="flex min-h-9 items-center gap-2 text-[14px] font-medium">
          <input
            type="checkbox"
            className="accent-primary size-[18px]"
            checked={ownOnly}
            onChange={(e) => setOwnOnly(e.target.checked)}
          />
          {t('prices.tariff.ownOnly', { count: own })}
        </label>
      </div>
      <p className="text-ink-3 m-0 text-[13px]">
        {t('prices.tariff.tableHint', { name: insurer.name })}
      </p>
      {shown.length === 0 ? (
        <p className="text-ink-3 m-0 text-[13px]">{t('prices.tariff.noRows')}</p>
      ) : (
        <ShownList items={shown} step={25} footerClassName="pt-1">
          {(page) => (
            <div className="border-border max-h-[calc(100vh-250px)] min-h-[240px] overflow-auto overscroll-contain rounded-md border">
              <table className="w-full border-collapse">
                <thead className="bg-surface sticky top-0 z-1">
                  <tr>
                    <th className={tableHead}>{t('prices.tariff.col.line')}</th>
                    <th className={cn(tableHead, 'text-right')}>{t('prices.tariff.col.cash')}</th>
                    <th className={cn(tableHead, 'text-right')}>
                      {t('prices.tariff.col.insurer', { name: insurer.name })}
                    </th>
                    <th className={cn(tableHead, 'text-right')}>
                      {t('prices.tariff.col.covered')}
                    </th>
                    <th className={cn(tableHead, 'text-right')}>
                      {t('prices.tariff.col.patient')}
                    </th>
                    <th className={cn(tableHead, 'text-right')}>
                      {t('prices.tariff.col.insurerPays', { name: insurer.name })}
                    </th>
                    <th className={tableHead}>
                      <span className="sr-only">{t('prices.edit')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {page.map((r) => {
                    const isEditing = editing === key(r)
                    return (
                      <tr key={key(r)} className={tableRow}>
                        <td className={tableCell}>
                          <span className="block font-medium">{name(r)}</span>
                          <span className="text-ink-3 text-[12px]">
                            {r.code} · {t(`prices.tariff.kinds.${r.kind}`)}
                            {r.kind === 'service' ? ` · ${t(`prices.groups.${r.group}`)}` : ''}
                          </span>
                        </td>
                        <td className={cn(tableCell, 'text-right tabular-nums')}>
                          {price(r.cashPrice)}
                        </td>
                        <td className={cn(tableCell, 'text-right tabular-nums')}>
                          {isEditing ? (
                            <form
                              className="flex items-center justify-end gap-1"
                              onSubmit={(e) => {
                                e.preventDefault()
                                void save(r)
                              }}
                            >
                              <Field
                                label={
                                  <span className="sr-only">
                                    {t('prices.tariff.col.insurer', { name: insurer.name })}
                                  </span>
                                }
                                inputMode="numeric"
                                autoFocus
                                value={draft}
                                onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
                                placeholder={t('prices.tariff.noOwnPrice')}
                                wrapperClassName="w-28"
                              />
                              <Button
                                type="submit"
                                size="sm"
                                variant="primary"
                                disabled={actions.setPrice.isPending}
                                title={t('prices.form.save')}
                                aria-label={t('prices.form.save')}
                              >
                                <Check size={14} aria-hidden="true" />
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => setEditing(null)}
                                title={t('staff.form.cancel')}
                                aria-label={t('staff.form.cancel')}
                              >
                                <X size={14} aria-hidden="true" />
                              </Button>
                            </form>
                          ) : (
                            <span className="inline-flex flex-col items-end gap-0.5">
                              <span
                                className={cn(
                                  'font-semibold',
                                  r.source === 'tariff' && 'text-primary',
                                )}
                              >
                                {price(r.price)}
                              </span>
                              <Badge tone={SOURCE_TONE[r.source]} dot={false}>
                                {t(`prices.tariff.sources.${r.source}`)}
                              </Badge>
                            </span>
                          )}
                        </td>
                        <td className={cn(tableCell, 'text-right tabular-nums')}>
                          {r.price == null ? '—' : `${r.coveragePct}%`}
                          {r.ask && (
                            <span className="text-red block text-[12px]">
                              {t('prices.tariff.askMark')}
                            </span>
                          )}
                        </td>
                        <td className={cn(tableCell, 'text-right font-semibold tabular-nums')}>
                          {price(r.patientShare)}
                        </td>
                        <td className={cn(tableCell, 'text-right tabular-nums')}>
                          {price(r.insurerShare)}
                        </td>
                        <td className={cn(tableCell, 'text-right')}>
                          {!isEditing && (
                            <Button
                              size="sm"
                              variant="tint-grey"
                              onClick={() => start(r)}
                              title={t('prices.tariff.editPrice')}
                              aria-label={t('prices.tariff.editPrice')}
                            >
                              <Pencil size={14} aria-hidden="true" />
                            </Button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </ShownList>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- the upload and a new list */

function ImportPanel({
  insurer,
  lists,
  run,
}: {
  insurer: Insurer
  lists: TariffList[]
  run: (fn: () => Promise<unknown>, done: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const actions = useInsurerTariffActions()
  const confirm = useConfirm()
  const fileInput = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [parsed, setParsed] = useState<ParsedTariffFile | null>(null)
  const [reading, setReading] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [from, setFrom] = useState(() => isoDate(new Date()))
  const [preview, setPreview] = useState<TariffPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [newName, setNewName] = useState('')
  const [newFrom, setNewFrom] = useState(() => isoDate(new Date()))
  const [copy, setCopy] = useState(true)
  const current = lists.find((l) => l.inEffect) ?? null
  const colName = (c: string) => t(`prices.tariff.col.file.${c}`)

  const removeFile = () => {
    if (parsed?.title && name === parsed.title.slice(0, 120)) setName('')
    setPreview(null)
    setError(null)
    setFileError(null)
    setParsed(null)
    setFileName('')
    if (fileInput.current) fileInput.current.value = ''
  }
  const choose = async (file: File | null) => {
    setPreview(null)
    setError(null)
    setFileError(null)
    setParsed(null)
    setFileName(file?.name ?? '')
    if (!file) return
    setReading(true)
    try {
      const p = await readTariffFile(file)
      setParsed(p)
      if (!name.trim() && p.title) setName(p.title.slice(0, 120))
    } catch (e) {
      const problem = e instanceof TariffFileError ? e.problem : 'unreadable'
      // an insurer's list: its own words for a missing header or no line
      setFileError(
        t(
          problem === 'noHeader' || problem === 'empty'
            ? `prices.tariff.fileErr.${problem}`
            : `prices.refList.fileErr.${problem}`,
        ),
      )
    } finally {
      setReading(false)
    }
  }
  const input = () => ({
    payerId: insurer.id,
    name: name.trim(),
    effectiveFrom: from,
    lines: parsed?.lines ?? [],
  })
  const check = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!parsed || !name.trim() || !from) {
      setError(t('prices.refList.needAll'))
      return
    }
    try {
      setPreview(await actions.check.mutateAsync(input()))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const use = async () => {
    if (!preview) return
    if (
      !(await confirm({
        title: t('prices.tariff.confirmTitle', {
          name: preview.name,
          insurer: insurer.name,
          date: day(from),
        }),
        body: t('prices.tariff.confirmBody', { count: preview.matched }),
        confirmLabel: t('prices.refList.confirmYes'),
      }))
    )
      return
    setError(null)
    try {
      const r = await actions.apply.mutateAsync(input())
      setPreview(null)
      removeFile()
      setName('')
      await run(
        () => Promise.resolve(),
        t('prices.tariff.done', {
          name: r.name,
          insurer: insurer.name,
          date: day(r.effectiveFrom),
          count: r.matched,
        }),
      )
    } catch (err) {
      setPreview(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const startNew = async (e: FormEvent) => {
    e.preventDefault()
    if (!newName.trim() || !newFrom) return
    if (
      !(await confirm({
        title: t('confirm.prices.newTariffTitle', { name: insurer.name, date: day(newFrom) }),
        body: t(copy ? 'confirm.prices.newTariffCopyBody' : 'confirm.prices.newTariffEmptyBody'),
        confirmLabel: t('confirm.prices.saveYes'),
      }))
    )
      return
    await run(
      () =>
        actions.startList.mutateAsync({
          payerId: insurer.id,
          name: newName.trim(),
          effectiveFrom: newFrom,
          copy,
        }),
      t('prices.tariff.started', { name: newName.trim(), date: day(newFrom) }),
    )
    setStarting(false)
    setNewName('')
  }

  return (
    <>
      <form
        onSubmit={(e) => void check(e)}
        className="border-border bg-surface/60 flex flex-col gap-3 border-t px-4 py-3"
      >
        <span className="text-navy-ink inline-flex items-center gap-2 text-[15px] font-semibold">
          <Upload size={16} aria-hidden="true" />
          {t('prices.tariff.upload', { name: insurer.name })}
        </span>
        <p className="text-ink-3 m-0 text-[13px]">{t('prices.tariff.uploadHint')}</p>
        <div className="flex items-stretch gap-2">
          <label
            className={cn(
              'border-border bg-card hover:border-navy/40 flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md border border-dashed px-3 py-2.5',
              reading && 'pointer-events-none opacity-60',
            )}
          >
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPT}
              className="sr-only"
              onChange={(e) => void choose(e.target.files?.[0] ?? null)}
            />
            <span className="bg-blue-bg text-navy-ink grid size-10 flex-none place-items-center rounded-md">
              <FileSpreadsheet size={20} aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-ink block text-[14px] font-semibold break-words">
                {reading ? t('prices.refList.reading') : fileName || t('prices.refList.choose')}
              </span>
              <span className="text-ink-3 block text-[13px]">
                {fileName ? t('prices.refList.fileChange') : t('prices.tariff.fileHint')}
              </span>
            </span>
          </label>
          {fileName && !reading && (
            <Button
              type="button"
              variant="tint-grey"
              className="h-auto self-stretch"
              onClick={removeFile}
              title={t('prices.refList.removeFile')}
            >
              <X size={16} aria-hidden="true" />
              <span className="max-[480px]:sr-only">{t('prices.refList.removeFile')}</span>
            </Button>
          )}
        </div>
        {fileError && (
          <p role="alert" className={errorBox}>
            {fileError}
          </p>
        )}
        {parsed && (
          <div className="border-navy/20 bg-blue-bg/60 flex flex-col gap-1 rounded-md border px-3 py-2 text-[13px]">
            <span className="text-ink font-semibold">
              {t('prices.refList.read', {
                count: parsed.lines.length,
                row: parsed.headerRow,
                sheet: parsed.sheet ?? fileName,
              })}
            </span>
            <span className="flex flex-wrap items-center gap-1">
              <span className="text-ink-2">{t('prices.refList.columnsFound')}</span>
              {parsed.columns.map((c) => (
                <Badge key={c} tone="green">
                  {colName(c)}
                </Badge>
              ))}
            </span>
            {parsed.missing.length > 0 && (
              <span className="flex flex-wrap items-center gap-1">
                <span className="text-ink-2">{t('prices.refList.columnsMissing')}</span>
                {parsed.missing.map((c) => (
                  <Badge key={c} tone="grey">
                    {colName(c)}
                  </Badge>
                ))}
              </span>
            )}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_200px]">
          <Field
            label={t('prices.refList.name')}
            value={name}
            maxLength={120}
            placeholder={t('prices.tariff.namePh', { name: insurer.name })}
            onChange={(e) => {
              setName(e.target.value)
              setPreview(null)
            }}
          />
          <Field
            label={t('prices.tariff.useFrom')}
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value)
              setPreview(null)
            }}
          />
        </div>
        {error && !preview && (
          <p role="alert" className={errorBox}>
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            variant="tint-blue"
            disabled={!parsed || reading || actions.check.isPending}
          >
            <ListChecks size={16} aria-hidden="true" />
            {actions.check.isPending ? t('prices.refList.checking') : t('prices.refList.check')}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setStarting(!starting)}>
            <Plus size={16} aria-hidden="true" />
            {t('prices.tariff.newList')}
          </Button>
          {current && (
            <span className="text-ink-3 text-[13px]">
              {t('prices.tariff.currentList', {
                name: current.name,
                date: day(current.effectiveFrom),
              })}
            </span>
          )}
        </div>
      </form>

      {starting && (
        <form
          onSubmit={(e) => void startNew(e)}
          className="border-border flex flex-col gap-3 border-t px-4 py-3"
        >
          <span className="text-ink text-[15px] font-semibold">
            {t('prices.tariff.newListTitle')}
          </span>
          <p className="text-ink-3 m-0 text-[13px]">{t('prices.tariff.newListHint')}</p>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_200px]">
            <Field
              label={t('prices.refList.name')}
              value={newName}
              maxLength={120}
              placeholder={t('prices.tariff.namePh', { name: insurer.name })}
              onChange={(e) => setNewName(e.target.value)}
              required
            />
            <Field
              label={t('prices.tariff.useFrom')}
              type="date"
              value={newFrom}
              onChange={(e) => setNewFrom(e.target.value)}
              required
            />
          </div>
          <label className="flex min-h-9 items-center gap-2 text-[14px] font-medium">
            <input
              type="checkbox"
              className="accent-primary size-[18px]"
              checked={copy}
              onChange={(e) => setCopy(e.target.checked)}
            />
            {t('prices.tariff.copyCurrent')}
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="primary"
              disabled={!newName.trim() || !newFrom || actions.startList.isPending}
            >
              <BookCheck size={16} aria-hidden="true" />
              {t('prices.tariff.startList', { date: day(newFrom) })}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setStarting(false)}>
              {t('staff.form.cancel')}
            </Button>
          </div>
        </form>
      )}

      {preview && (
        <PreviewPanel
          insurer={insurer}
          preview={preview}
          from={from}
          busy={actions.apply.isPending}
          error={error}
          onClose={() => setPreview(null)}
          onUse={() => void use()}
        />
      )}
    </>
  )
}

/** The dry run: what the uploaded list matched, before it is used. */
function PreviewPanel({
  insurer,
  preview,
  from,
  busy,
  error,
  onClose,
  onUse,
}: {
  insurer: Insurer
  preview: TariffPreview
  from: string
  busy: boolean
  error: string | null
  onClose: () => void
  onUse: () => void
}) {
  const { t } = useTranslation()
  const tiles: { label: string; value: number; hue: Hue }[] = [
    { label: t('prices.tariff.tile.matched'), value: preview.matched, hue: 'teal' },
    { label: t('prices.tariff.tile.new'), value: preview.new, hue: 'mint' },
    { label: t('prices.tariff.tile.changed'), value: preview.changed, hue: 'amber' },
    { label: t('prices.tariff.tile.unchanged'), value: preview.unchanged, hue: 'navy' },
    { label: t('prices.tariff.tile.unmatched'), value: preview.unmatched.length, hue: 'coral' },
  ]
  return (
    <SidePanel
      open
      onClose={onClose}
      hue="blue"
      icon={ListChecks}
      title={t('prices.tariff.previewTitle', { name: preview.name, insurer: insurer.name })}
      subtitle={
        preview.previous
          ? t('prices.tariff.comparedWith', {
              name: preview.previous.name,
              count: preview.previous.rows,
            })
          : t('prices.tariff.firstList')
      }
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('staff.form.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy || preview.matched === 0}
            onClick={onUse}
          >
            <BookCheck size={16} aria-hidden="true" />
            {t('prices.refList.use', { date: day(from) })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-ink-2 m-0 text-[14px]">
          {t('prices.tariff.kept', { count: preview.matched, total: preview.total })}
        </p>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
          {tiles.map((x) => (
            <div
              key={x.label}
              className={cn('rounded-lg2 flex flex-col border p-3', tileClass[x.hue])}
            >
              <span className="text-ink-2 text-[13px]">{x.label}</span>
              <span className="text-ink text-[28px] leading-tight font-semibold tabular-nums">
                {formatNumber(x.value)}
              </span>
            </div>
          ))}
        </div>
        {error && (
          <p role="alert" className={errorBox}>
            {error}
          </p>
        )}
        <section className="flex flex-col gap-1">
          <h3 className="text-ink m-0 text-[15px] font-semibold">
            {t('prices.tariff.unmatchedTitle')}
          </h3>
          {preview.unmatched.length === 0 ? (
            <p className="text-ink-3 m-0 text-[13px]">{t('prices.tariff.allMatched')}</p>
          ) : (
            <>
              <p className="text-ink-3 m-0 text-[13px]">{t('prices.tariff.unmatchedHint')}</p>
              <ShownList items={preview.unmatched} step={15} footerClassName="pt-1">
                {(rows) =>
                  rows.map((u, i) => (
                    <Row key={`${u.row}-${i}`} className="flex-wrap gap-x-2 gap-y-1 px-0 py-1.5">
                      <Badge tone="red">{t('prices.refList.rowN', { n: u.row })}</Badge>
                      <span className="min-w-[160px] flex-1 text-[14px]">
                        <span className="text-ink block font-medium">
                          {u.name || u.code || '—'}
                        </span>
                        <span className="text-ink-3 text-[12px]">
                          {[u.code, u.price].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      <span className="text-ink-2 text-[13px]">
                        {t(`prices.tariff.reasons.${u.reason}`, { defaultValue: u.reason })}
                      </span>
                    </Row>
                  ))
                }
              </ShownList>
            </>
          )}
        </section>
      </div>
    </SidePanel>
  )
}

/** The insurer's lists: the one in effect, the ones to come and the past ones. */
function ListsHistory({ lists }: { lists: TariffList[] }) {
  const { t } = useTranslation()
  if (lists.length === 0) return null
  return (
    <div className="border-border flex flex-col gap-1 border-t px-4 py-3">
      <span className="text-ink-2 inline-flex items-center gap-1.5 text-[13px] font-semibold">
        <History size={14} aria-hidden="true" />
        {t('prices.tariff.history')}
      </span>
      <ShownList items={lists} step={4} footerClassName="pt-1">
        {(rows) =>
          rows.map((l) => (
            <Row key={l.id} className="flex-wrap gap-x-3 gap-y-1 px-0 py-1.5">
              <span className="min-w-[min(200px,100%)] flex-1">
                <span className="text-ink block text-[14px] font-semibold">{l.name}</span>
                <span className="text-ink-3 block text-[13px]">
                  {[
                    l.effectiveTo
                      ? t('prices.tariff.fromTo', {
                          from: day(l.effectiveFrom),
                          to: day(l.effectiveTo),
                        })
                      : t('prices.refList.from', { date: day(l.effectiveFrom) }),
                    t('prices.refList.rows', { count: l.rows, n: formatNumber(l.rows) }),
                    l.createdBy && l.createdAt
                      ? t('prices.refList.uploadedBy', {
                          name: l.createdBy,
                          date: formatDate(new Date(l.createdAt)),
                        })
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              {l.inEffect ? (
                <Badge tone="green">{t('prices.refList.inUse')}</Badge>
              ) : l.future ? (
                <Badge tone="yellow">
                  {t('prices.refList.from', { date: day(l.effectiveFrom) })}
                </Badge>
              ) : (
                <Badge tone="grey">{t('prices.tariff.past')}</Badge>
              )}
            </Row>
          ))
        }
      </ShownList>
    </div>
  )
}

/* ---------------------------------------------------------------- the insurer form */

export function InsurerForm({
  insurer,
  onClose,
}: {
  insurer: Insurer | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const actions = useCatalogueActions()
  const confirm = useConfirm()
  const [name, setName] = useState(insurer?.name ?? '')
  const [code, setCode] = useState(insurer?.code ?? '')
  const [type, setType] = useState<PayerType>(insurer?.type ?? 'private')
  const [coverage, setCoverage] = useState(String(insurer?.coveragePct ?? 80))
  const [active, setActive] = useState(insurer?.active ?? true)
  const [follows, setFollows] = useState<boolean | null>(insurer?.followsReferenceList ?? null)
  const [rule, setRule] = useState<NotListedRule>(insurer?.notListedRule ?? 'cash_covered')
  const [byGroup, setByGroup] = useState<Record<string, string>>(
    Object.fromEntries(
      SERVICE_GROUPS.map((g) => [
        g,
        insurer?.pctByGroup[g] != null ? String(insurer.pctByGroup[g]) : '',
      ]),
    ),
  )
  const [error, setError] = useState<string | null>(null)
  // a new insurer of these kinds follows the official list unless the form says otherwise
  const followsShown = follows ?? ['rssb_rama', 'mmi', 'cbhi'].includes(type)

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
    if (
      !(await confirm({
        title: t(insurer ? 'confirm.prices.saveInsurerTitle' : 'confirm.prices.addInsurerTitle', {
          name: name.trim(),
          pct: c,
        }),
        confirmLabel: t('confirm.prices.saveYes'),
      }))
    )
      return
    try {
      await actions.saveInsurer.mutateAsync({
        id: insurer?.id,
        code,
        name,
        type,
        coveragePct: c,
        pctByGroup,
        active,
        followsReferenceList: followsShown,
        notListedRule: rule,
      })
      onClose()
    } catch (err) {
      setError(t('prices.errors.generic', { message: err instanceof Error ? err.message : '' }))
    }
  }

  return (
    <SidePanel
      open
      onClose={onClose}
      hue="mint"
      icon={ShieldCheck}
      title={
        insurer ? t('prices.insurers.editTitle', { name: insurer.name }) : t('prices.insurers.new')
      }
      subtitle={
        insurer ? `${insurer.code} · ${t(`prices.insurers.types.${insurer.type}`)}` : undefined
      }
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('staff.form.cancel')}
          </Button>
          <Button
            type="submit"
            form={INSURER_FORM}
            variant="primary"
            disabled={actions.saveInsurer.isPending}
          >
            {actions.saveInsurer.isPending ? t('settings.saving') : t('prices.form.save')}
          </Button>
        </>
      }
    >
      <form id={INSURER_FORM} onSubmit={(e) => void submit(e)}>
        <CardBody className="gap-3 p-0">
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
          {payerBodyOf(type) && (
            <p className="text-navy-ink m-0 text-[13px]">{t('prices.insurers.form.rssbHint')}</p>
          )}
          <span className="text-ink-2 text-[14px] font-semibold">
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
          <label className="flex min-h-9 items-center gap-2 text-[14px] font-medium">
            <input
              type="checkbox"
              className="accent-primary size-[18px]"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            {t('prices.insurers.form.active')}
          </label>
          <label className="flex min-h-9 items-center gap-2 text-[14px] font-medium">
            <input
              type="checkbox"
              className="accent-primary size-[18px]"
              checked={followsShown}
              onChange={(e) => setFollows(e.target.checked)}
            />
            {t('prices.tariff.followsList')}
          </label>
          <Select
            label={t('prices.tariff.notListed')}
            value={rule}
            onChange={(e) => setRule(e.target.value as NotListedRule)}
          >
            {NOT_LISTED_RULES.map((r) => (
              <option key={r} value={r}>
                {t(`prices.tariff.rules.${r}`)}
              </option>
            ))}
          </Select>
          <p className="text-ink-3 m-0 text-xs">
            {t(`prices.tariff.rulesHint.${rule}`, {
              name: name.trim() || t('prices.tariff.theInsurer'),
            })}
          </p>
          <p className="text-ink-3 m-0 text-xs">{t('prices.tariff.publicNote')}</p>
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
