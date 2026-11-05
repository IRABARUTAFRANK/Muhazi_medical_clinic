import { useEffect, useState, type FormEvent } from 'react'
import { Pencil, Plus, RotateCcw, Save, ShieldCheck, ShieldOff, Table2, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatNumber } from '@mmc/shared'
import { tableCell, tableHead, tableRow } from '@/components/dash/kit-style'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { SidePanel } from '@/components/ui/side-panel'
import type { Insurer } from '@/lib/api/catalogue'
import {
  COVERS,
  usePriceListActions,
  usePriceListLines,
  type Cover,
  type PriceListBook,
  type PriceListLine,
} from '@/lib/api/price-lists'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import { coverTone, day, errorBox, price } from './price-list-kit'

const PAGE = 200
const digits = (s: string) => s.replace(/[^\d]/g, '')

/**
 * The lines of a list (Prices › Published price lists › See the lines): one version at a time,
 * searched by code or name, by section. The version in use can be changed by hand: a line's name,
 * prices and instruction (the line as uploaded is kept), a line added, a line taken out (and put
 * back). With "Exceptions of" an insurer, each line shows that insurer's exception and the
 * manager sets one: not covered, covered only with its approval, its own price, a note.
 */
export function LinesPanel({
  book,
  insurers,
  onClose,
  onNotice,
}: {
  book: PriceListBook
  insurers: Insurer[]
  onClose: () => void
  onNotice: (text: string) => void
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const actions = usePriceListActions()
  const current = book.versions.find((v) => v.status === 'current') ?? book.versions[0]!
  const [versionId, setVersionId] = useState(current.id)
  const version = book.versions.find((v) => v.id === versionId) ?? current
  const editable = version.status === 'current'
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [section, setSection] = useState('')
  const [payerId, setPayerId] = useState(book.followers[0]?.payerId ?? '')
  const [limit, setLimit] = useState(PAGE)
  const [editing, setEditing] = useState<PriceListLine | 'new' | null>(null)
  const [excepting, setExcepting] = useState<PriceListLine | null>(null)
  const [error, setError] = useState<string | null>(null)
  // the search runs a moment after typing stops
  useEffect(() => {
    const h = window.setTimeout(() => setQuery(search), 300)
    return () => window.clearTimeout(h)
  }, [search])
  const {
    data,
    error: loadError,
    isFetching,
  } = usePriceListLines({
    versionId,
    search: query,
    payerId: payerId || null,
    section: section || null,
    limit,
  })
  const payer = insurers.find((i) => i.id === payerId) ?? null
  const lines = data?.lines ?? []
  const cols = version.columns

  const remove = async (l: PriceListLine, restore: boolean) => {
    setError(null)
    if (
      !restore &&
      !(await confirm({
        title: t('prices.lists.removeQ', { name: l.name }),
        body: t('prices.lists.removeBody'),
        confirmLabel: t('prices.lists.removeYes'),
        tone: 'danger',
      }))
    )
      return
    try {
      await actions.removeLine.mutateAsync({ versionId, code: l.code, restore })
      onNotice(t(restore ? 'prices.lists.restored' : 'prices.lists.removed', { name: l.name }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <SidePanel
      open
      onClose={onClose}
      hue="lavender"
      icon={Table2}
      // wide enough for a tariff of six price columns
      className="w-[1100px]"
      title={book.name}
      subtitle={t('prices.lists.linesSubtitle', {
        name: version.name,
        date: day(version.effectiveFrom),
        count: version.rows,
      })}
    >
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label={t('prices.lists.version')}
            value={versionId}
            onChange={(e) => {
              setVersionId(e.target.value)
              setEditing(null)
              setExcepting(null)
              setLimit(PAGE)
            }}
          >
            {book.versions.map((v) => (
              <option key={v.id} value={v.id}>
                {`${v.name} · ${t('prices.lists.from', { date: day(v.effectiveFrom) })}${
                  v.status === 'current' ? ` · ${t('prices.lists.current')}` : ''
                }`}
              </option>
            ))}
          </Select>
          <Select
            label={t('prices.lists.exceptionsOf')}
            value={payerId}
            onChange={(e) => {
              setPayerId(e.target.value)
              setExcepting(null)
            }}
          >
            <option value="">{t('prices.lists.noInsurer')}</option>
            {insurers.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </Select>
          <Field
            label={t('prices.lists.search')}
            value={search}
            placeholder={t('prices.lists.searchPh')}
            onChange={(e) => {
              setSearch(e.target.value)
              setLimit(PAGE)
            }}
          />
          <Select
            label={t('prices.lists.section')}
            value={section}
            onChange={(e) => {
              setSection(e.target.value)
              setLimit(PAGE)
            }}
          >
            <option value="">{t('prices.lists.allSections')}</option>
            {(data?.sections ?? []).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </div>
        {!editable && (
          <p className="text-ink-3 m-0 text-[13px]">{t('prices.lists.pastReadOnly')}</p>
        )}
        {version.notes && (
          <p className="text-ink-2 bg-surface m-0 rounded-md px-3 py-2 text-[13px] whitespace-pre-line">
            {version.notes}
          </p>
        )}
        {(loadError || error) && (
          <p role="alert" className={errorBox}>
            {error ?? loadError?.message}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ink-2 flex-1 text-[13px]">
            {t('prices.lists.shown', {
              shown: formatNumber(lines.length),
              total: formatNumber(data?.total ?? 0),
            })}
            {isFetching && ` · ${t('prices.lists.loading')}`}
          </span>
          {editable && (
            <Button
              size="sm"
              variant="tint-violet"
              onClick={() => {
                setExcepting(null)
                setEditing('new')
              }}
            >
              <Plus size={14} aria-hidden="true" />
              {t('prices.lists.addLine')}
            </Button>
          )}
        </div>
        {editing && (
          <LineForm
            key={editing === 'new' ? 'new' : editing.code}
            versionId={versionId}
            columns={cols}
            line={editing === 'new' ? null : editing}
            onDone={(name) => {
              setEditing(null)
              onNotice(t('prices.lists.lineSaved', { name }))
            }}
            onCancel={() => setEditing(null)}
          />
        )}
        {excepting && payer && (
          <ExceptionForm
            key={excepting.code}
            line={excepting}
            payer={payer}
            bookId={book.id}
            onDone={(text) => {
              setExcepting(null)
              onNotice(text)
            }}
            onCancel={() => setExcepting(null)}
          />
        )}
        <div className="border-border max-h-[62vh] overflow-auto overscroll-contain rounded-md border">
          <table className="w-full border-collapse text-[13px]">
            <thead className="bg-surface sticky top-0 z-1">
              <tr>
                <th className={tableHead}>{t('prices.lists.colLine')}</th>
                {cols.map((c) => (
                  <th key={c.key} className={cn(tableHead, 'text-right whitespace-nowrap')}>
                    {c.label}
                  </th>
                ))}
                {payer && <th className={tableHead}>{payer.name}</th>}
                <th className={tableHead}>
                  <span className="sr-only">{t('prices.lists.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.code} className={cn(tableRow, l.removed && 'opacity-55')}>
                  <td className={cn(tableCell, 'min-w-[220px]')}>
                    <span className={cn('block font-medium', l.removed && 'line-through')}>
                      {l.name}
                    </span>
                    <span className="text-ink-3 block text-[12px]">
                      {[l.code, l.section, l.altCode, l.unit].filter(Boolean).join(' · ')}
                    </span>
                    {l.note && <span className="text-ink-2 block text-[12px]">“{l.note}”</span>}
                    <span className="mt-0.5 flex flex-wrap gap-1">
                      {l.clinic.map((c) => (
                        <Badge key={c.id} tone="green">
                          {t('prices.lists.atClinicName', { name: c.name })}
                        </Badge>
                      ))}
                      {l.edited && !l.removed && (
                        <Badge tone="yellow">
                          {l.original?.added ? t('prices.lists.added') : t('prices.lists.edited')}
                        </Badge>
                      )}
                      {l.removed && <Badge tone="grey">{t('prices.lists.takenOut')}</Badge>}
                    </span>
                  </td>
                  {cols.map((c) => {
                    const was = l.original?.prices?.[c.key]
                    const changed = l.original?.prices && was !== l.prices[c.key]
                    return (
                      <td
                        key={c.key}
                        className={cn(tableCell, 'text-right whitespace-nowrap tabular-nums')}
                      >
                        {price(l.prices[c.key])}
                        {changed && (
                          <span className="text-ink-3 block text-[11px] line-through">
                            {price(was)}
                          </span>
                        )}
                      </td>
                    )
                  })}
                  {payer && (
                    <td className={cn(tableCell, 'min-w-[120px]')}>
                      {l.exception ? (
                        <span className="flex flex-col items-start gap-0.5">
                          <Badge tone={coverTone(l.exception.cover)}>
                            {t(`prices.lists.cover.${l.exception.cover}`)}
                          </Badge>
                          {l.exception.price != null && (
                            <span className="tabular-nums">{price(l.exception.price)}</span>
                          )}
                          {l.exception.note && (
                            <span className="text-ink-3 text-[12px]">{l.exception.note}</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                  )}
                  <td className={cn(tableCell, 'whitespace-nowrap')}>
                    <span className="flex justify-end gap-1">
                      {payer && (
                        <Button
                          size="sm"
                          variant="ghost"
                          title={t('prices.lists.setException', { payer: payer.name })}
                          onClick={() => {
                            setEditing(null)
                            setExcepting(l)
                          }}
                        >
                          <ShieldOff size={14} aria-hidden="true" />
                          <span className="sr-only">
                            {t('prices.lists.setException', { payer: payer.name })}
                          </span>
                        </Button>
                      )}
                      {editable && !l.removed && (
                        <Button
                          size="sm"
                          variant="ghost"
                          title={t('prices.lists.editLine')}
                          onClick={() => {
                            setExcepting(null)
                            setEditing(l)
                          }}
                        >
                          <Pencil size={14} aria-hidden="true" />
                          <span className="sr-only">{t('prices.lists.editLine')}</span>
                        </Button>
                      )}
                      {editable && (
                        <Button
                          size="sm"
                          variant="ghost"
                          title={t(l.removed ? 'prices.lists.restore' : 'prices.lists.remove')}
                          onClick={() => void remove(l, l.removed)}
                        >
                          {l.removed ? (
                            <RotateCcw size={14} aria-hidden="true" />
                          ) : (
                            <Trash2 size={14} aria-hidden="true" />
                          )}
                          <span className="sr-only">
                            {t(l.removed ? 'prices.lists.restore' : 'prices.lists.remove')}
                          </span>
                        </Button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && lines.length < data.total && (
          <Button
            variant="tint-grey"
            className="self-start"
            onClick={() => setLimit((n) => n + PAGE)}
          >
            {t('prices.lists.showMore')}
          </Button>
        )}
      </div>
    </SidePanel>
  )
}

/** A line changed or added by hand: its name, prices per column, instruction, section, unit. */
function LineForm({
  versionId,
  columns,
  line,
  onDone,
  onCancel,
}: {
  versionId: string
  columns: { key: string; label: string }[]
  line: PriceListLine | null
  onDone: (name: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const actions = usePriceListActions()
  const [code, setCode] = useState(line?.code ?? '')
  const [name, setName] = useState(line?.name ?? '')
  const [note, setNote] = useState(line?.note ?? '')
  const [section, setSection] = useState(line?.section ?? '')
  const [unit, setUnit] = useState(line?.unit ?? '')
  const [prices, setPrices] = useState<Record<string, string>>(() =>
    Object.fromEntries(columns.map((c) => [c.key, line?.prices[c.key]?.toString() ?? ''])),
  )
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!code.trim() || !name.trim()) return setError(t('prices.lists.needCodeName'))
    try {
      await actions.saveLine.mutateAsync({
        versionId,
        code,
        name,
        prices: Object.fromEntries(
          columns.map((c) => [c.key, prices[c.key] ? Number(prices[c.key]) : null]),
        ),
        note: note.trim() || null,
        section: section.trim() || null,
        unit: unit.trim() || null,
        detail: line?.detail ?? null,
        isNew: !line,
      })
      onDone(name.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="border-violet/30 bg-violet-bg/40 flex flex-col gap-3 rounded-md border p-3"
    >
      <span className="text-ink text-[14px] font-semibold">
        {line ? t('prices.lists.editTitle', { name: line.name }) : t('prices.lists.addTitle')}
      </span>
      <div className="grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)]">
        <Field
          label={t('prices.lists.code')}
          value={code}
          disabled={!!line}
          maxLength={40}
          onChange={(e) => setCode(e.target.value)}
        />
        <Field
          label={t('prices.lists.lineName')}
          value={name}
          maxLength={300}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {columns.map((c) => (
          <Field
            key={c.key}
            label={c.label}
            inputMode="numeric"
            value={prices[c.key] ?? ''}
            onChange={(e) => setPrices((p) => ({ ...p, [c.key]: digits(e.target.value) }))}
          />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={t('prices.lists.sectionLabel')}
          value={section}
          maxLength={200}
          onChange={(e) => setSection(e.target.value)}
        />
        <Field
          label={t('prices.lists.unit')}
          value={unit}
          maxLength={60}
          onChange={(e) => setUnit(e.target.value)}
        />
      </div>
      <Field
        label={t('prices.lists.noteLabel')}
        value={note}
        maxLength={500}
        onChange={(e) => setNote(e.target.value)}
      />
      {line?.original && !line.original.added && (
        <p className="text-ink-3 m-0 text-[12px]">
          {t('prices.lists.asUploaded', {
            prices: columns
              .map((c) => `${c.label} ${price(line.original?.prices?.[c.key])}`)
              .join(' · '),
          })}
        </p>
      )}
      {error && (
        <p role="alert" className={errorBox}>
          {error}
        </p>
      )}
      <span className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={actions.saveLine.isPending}>
          <Save size={14} aria-hidden="true" />
          {t('prices.lists.saveLine')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('staff.form.cancel')}
        </Button>
      </span>
    </form>
  )
}

/** One insurer's exception on one line: its cover, its own price, a note (or none). */
function ExceptionForm({
  line,
  payer,
  bookId,
  onDone,
  onCancel,
}: {
  line: PriceListLine
  payer: Insurer
  bookId: string
  onDone: (text: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const actions = usePriceListActions()
  const [cover, setCover] = useState<Cover>(line.exception?.cover ?? 'covered')
  const [own, setOwn] = useState(line.exception?.price?.toString() ?? '')
  const [note, setNote] = useState(line.exception?.note ?? '')
  const [error, setError] = useState<string | null>(null)
  const save = async (clear: boolean) => {
    setError(null)
    try {
      await actions.saveException.mutateAsync({
        payerId: payer.id,
        code: line.code,
        cover: clear ? 'covered' : cover,
        price: clear || !own ? null : Number(own),
        note: clear ? null : note.trim() || null,
        bookId,
      })
      onDone(
        t(clear ? 'prices.lists.exceptionCleared' : 'prices.lists.exceptionSaved', {
          payer: payer.name,
          name: line.name,
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void save(false)
      }}
      className="border-navy/30 bg-blue-bg/50 flex flex-col gap-3 rounded-md border p-3"
    >
      <span className="text-ink text-[14px] font-semibold">
        {t('prices.lists.exceptionTitle', { payer: payer.name, name: line.name })}
      </span>
      {line.exception?.source === 'upload' && (
        <p className="text-ink-3 m-0 text-[12px]">{t('prices.lists.fromUpload')}</p>
      )}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
        <Select
          label={t('prices.lists.coverLabel')}
          value={cover}
          onChange={(e) => setCover(e.target.value as Cover)}
        >
          {COVERS.map((c) => (
            <option key={c} value={c}>
              {t(`prices.lists.cover.${c}`)}
            </option>
          ))}
        </Select>
        <Field
          label={t('prices.lists.ownPrice')}
          inputMode="numeric"
          value={own}
          placeholder={t('prices.lists.ownPricePh')}
          onChange={(e) => setOwn(digits(e.target.value))}
        />
      </div>
      <Field
        label={t('prices.lists.noteLabel')}
        value={note}
        maxLength={500}
        onChange={(e) => setNote(e.target.value)}
      />
      <p className="text-ink-3 m-0 text-[12px]">
        {t(`prices.lists.coverHint.${cover}`, { payer: payer.name })}
      </p>
      {error && (
        <p role="alert" className={errorBox}>
          {error}
        </p>
      )}
      <span className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={actions.saveException.isPending}>
          <ShieldCheck size={14} aria-hidden="true" />
          {t('prices.lists.saveException')}
        </Button>
        {line.exception && (
          <Button type="button" variant="tint-coral" onClick={() => void save(true)}>
            {t('prices.lists.clearException')}
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('staff.form.cancel')}
        </Button>
      </span>
    </form>
  )
}

/**
 * The insurers that follow a list (Prices › Published price lists › Insurers): for each insurer,
 * the price column it pays (none: it does not follow the list) and its order among the lists it
 * follows (the first list with the line prices it).
 */
export function FollowersPanel({
  book,
  insurers,
  onClose,
  onNotice,
}: {
  book: PriceListBook
  insurers: Insurer[]
  onClose: () => void
  onNotice: (text: string) => void
}) {
  const { t } = useTranslation()
  const current = book.versions.find((v) => v.status === 'current') ?? book.versions[0]
  const columns = current?.columns ?? []
  return (
    <SidePanel
      open
      onClose={onClose}
      hue="blue"
      icon={ShieldCheck}
      title={t('prices.lists.followersTitle', { name: book.name })}
      subtitle={t('prices.lists.followersSubtitle')}
    >
      <div className="flex flex-col gap-3">
        <p className="text-ink-2 m-0 text-[14px]">{t('prices.lists.followersLead')}</p>
        {insurers.length === 0 && (
          <p className="text-ink-3 m-0 text-[14px]">{t('prices.lists.noInsurers')}</p>
        )}
        {insurers.map((i) => (
          <FollowerRow key={i.id} insurer={i} book={book} columns={columns} onNotice={onNotice} />
        ))}
      </div>
    </SidePanel>
  )
}

function FollowerRow({
  insurer,
  book,
  columns,
  onNotice,
}: {
  insurer: Insurer
  book: PriceListBook
  columns: { key: string; label: string }[]
  onNotice: (text: string) => void
}) {
  const { t } = useTranslation()
  const actions = usePriceListActions()
  const follower = book.followers.find((f) => f.payerId === insurer.id) ?? null
  const [column, setColumn] = useState(follower?.column ?? '')
  const [order, setOrder] = useState(follower ? String(follower.priority) : '')
  const [error, setError] = useState<string | null>(null)
  const dirty =
    column !== (follower?.column ?? '') ||
    (!!column && order !== (follower ? String(follower.priority) : ''))
  const save = async () => {
    setError(null)
    try {
      await actions.follow.mutateAsync({
        payerId: insurer.id,
        payer: insurer.name,
        bookId: book.id,
        column: column || null,
        priority: order ? Number(order) : null,
      })
      const label = columns.find((c) => c.key === column)?.label ?? ''
      onNotice(
        column
          ? t('prices.lists.followSaved', { payer: insurer.name, list: book.name, column: label })
          : t('prices.lists.followStopped', { payer: insurer.name, list: book.name }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <div className="border-border bg-card flex flex-col gap-2 rounded-md border px-3 py-2.5">
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-ink flex-1 text-[15px] font-semibold">{insurer.name}</span>
        {follower ? (
          <Badge tone="green">{t('prices.lists.follows')}</Badge>
        ) : (
          <Badge tone="grey">{t('prices.lists.doesNotFollow')}</Badge>
        )}
      </span>
      <div className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_110px_auto]">
        <Select
          label={t('prices.lists.payColumn')}
          value={column}
          onChange={(e) => setColumn(e.target.value)}
        >
          <option value="">{t('prices.lists.notFollow')}</option>
          {columns.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </Select>
        <Field
          label={t('prices.lists.order')}
          inputMode="numeric"
          value={order}
          disabled={!column}
          placeholder={t('prices.lists.orderPh')}
          onChange={(e) => setOrder(digits(e.target.value).slice(0, 4))}
        />
        <Button
          variant="tint-blue"
          disabled={!dirty}
          loading={actions.follow.isPending}
          onClick={() => void save()}
        >
          <Save size={14} aria-hidden="true" />
          {t('prices.lists.saveFollow')}
        </Button>
      </div>
      {error && (
        <p role="alert" className={errorBox}>
          {error}
        </p>
      )}
    </div>
  )
}
