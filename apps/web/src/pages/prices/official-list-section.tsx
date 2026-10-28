import { useRef, useState, type FormEvent } from 'react'
import { BookCheck, FileSpreadsheet, History, ListChecks, Upload, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatNumber, formatRwf, isoDate } from '@mmc/shared'
import { tableCell, tableHead, tableRow, tileClass, type Hue } from '@/components/dash/kit-style'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { ShownList } from '@/components/ui/list-tools'
import { SidePanel } from '@/components/ui/side-panel'
import {
  useReferenceImport,
  useReferenceLists,
  type ReferenceList,
  type ReferencePreview,
} from '@/lib/api/reference-list'
import { useConfirm } from '@/lib/confirm'
import {
  readReferenceFile,
  ReferenceFileError,
  type ParsedReferenceFile,
} from '@/lib/reference-file'
import { cn } from '@/lib/utils'

const errorBox =
  'border-red/30 bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[14px] font-medium'
const ACCEPT =
  '.xlsx,.csv,.pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,application/pdf'

/** "2026-06-01" → 01/06/2026 (a calendar day, no time zone shift). */
const day = (iso: string) => (iso ? formatDate(new Date(`${iso.slice(0, 10)}T00:00:00`)) : '')
const when = (iso: string | null) => (iso ? formatDate(new Date(iso)) : '')
const price = (n: number | null) => (n == null ? '—' : formatRwf(n))

/**
 * The official medicine list (Prices, under the medicines): the list in use and the earlier ones,
 * and the upload of a new one. The manager chooses the Excel file the RHIA publishes (or a CSV),
 * names it and says from when it is used; "Check the list" shows what changes (new medicines,
 * price changes, medicines removed, rows left out) in a side panel, and "Use this list from …"
 * makes it the current list after the confirmation. Its prices are what insurers that follow
 * the list pay; the clinic's cash prices do not change.
 */
export function OfficialListSection({ onNotice }: { onNotice: (text: string) => void }) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { data: lists = [], error: listError } = useReferenceLists()
  const actions = useReferenceImport()
  const fileInput = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [parsed, setParsed] = useState<ParsedReferenceFile | null>(null)
  const [reading, setReading] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [from, setFrom] = useState(() => isoDate(new Date()))
  const [preview, setPreview] = useState<ReferencePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const current = lists.find((l) => l.status === 'current') ?? null
  const past = lists.filter((l) => l.status === 'past')
  const colName = (c: string) => t(`prices.refList.col.${c}`)

  /** The wrong file: forget it, what was read from it and the name it suggested. */
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
      const p = await readReferenceFile(file)
      setParsed(p)
      if (!name.trim() && p.title) setName(p.title.slice(0, 120))
    } catch (e) {
      const problem = e instanceof ReferenceFileError ? e.problem : 'unreadable'
      setFileError(t(`prices.refList.fileErr.${problem}`))
    } finally {
      setReading(false)
    }
  }

  const input = () => ({ name: name.trim(), effectiveFrom: from, rows: parsed?.rows ?? [] })

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
        title: t('prices.refList.confirmTitle', { name: preview.name, date: day(from) }),
        body: t('prices.refList.confirmBody', { count: preview.rows }),
        confirmLabel: t('prices.refList.confirmYes'),
      }))
    )
      return
    setError(null)
    try {
      const r = await actions.apply.mutateAsync(input())
      setPreview(null)
      setParsed(null)
      setFileName('')
      setName('')
      if (fileInput.current) fileInput.current.value = ''
      onNotice(
        [
          t('prices.refList.done', { name: r.name, date: day(r.effectiveFrom) }),
          r.itemsFlagged > 0 ? t('prices.refList.doneFlagged', { count: r.itemsFlagged }) : '',
        ]
          .filter(Boolean)
          .join(' '),
      )
    } catch (err) {
      setPreview(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader icon={BookCheck} hue="navy">
        <span className="min-w-0 flex-1">{t('prices.refList.title')}</span>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <p className="text-ink-2 m-0 text-[14px]">{t('prices.refList.lead')}</p>
        {listError && (
          <p role="alert" className={errorBox}>
            {listError.message}
          </p>
        )}
        {current ? (
          <ListLine list={current} />
        ) : (
          <p className="text-ink-3 m-0 text-[14px]">{t('prices.refList.none')}</p>
        )}
        {past.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-ink-2 inline-flex items-center gap-1.5 text-[13px] font-semibold">
              <History size={14} aria-hidden="true" />
              {t('prices.refList.past')}
            </span>
            <ShownList items={past} step={3} footerClassName="pt-1">
              {(rows) =>
                rows.map((l) => (
                  <Row key={l.id} className="flex-wrap gap-x-3 gap-y-1 px-0 py-1.5">
                    <ListLine list={l} compact />
                  </Row>
                ))
              }
            </ShownList>
          </div>
        )}
      </CardBody>

      <form
        onSubmit={(e) => void check(e)}
        className="border-border bg-surface/60 flex flex-col gap-3 border-t px-4 py-3"
      >
        <span className="text-navy-ink inline-flex items-center gap-2 text-[15px] font-semibold">
          <Upload size={16} aria-hidden="true" />
          {t('prices.refList.upload')}
        </span>
        <div className="flex flex-col gap-1">
          <span className="text-ink-2 text-[13px] font-medium">{t('prices.refList.file')}</span>
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
                  {fileName ? t('prices.refList.fileChange') : t('prices.refList.fileHint')}
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
                count: parsed.rows.length,
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
            placeholder={t('prices.refList.namePh')}
            onChange={(e) => {
              setName(e.target.value)
              setPreview(null)
            }}
          />
          <Field
            label={t('prices.refList.effective')}
            type="date"
            value={from}
            min={current?.effectiveFrom}
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
          <span className="text-ink-3 text-[13px]">{t('prices.refList.insurersNote')}</span>
        </div>
      </form>

      {preview && (
        <PreviewPanel
          preview={preview}
          from={from}
          busy={actions.apply.isPending}
          error={error}
          onClose={() => setPreview(null)}
          onUse={() => void use()}
        />
      )}
    </Card>
  )
}

/** A list: name, from when, how many medicines, who uploaded it. */
function ListLine({ list, compact }: { list: ReferenceList; compact?: boolean }) {
  const { t } = useTranslation()
  const uploaded = list.uploadedAt
    ? list.uploadedBy
      ? t('prices.refList.uploadedBy', { name: list.uploadedBy, date: when(list.uploadedAt) })
      : t('prices.refList.uploadedOn', { date: when(list.uploadedAt) })
    : t('prices.refList.loaded')
  return (
    <div
      className={cn(
        'flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1',
        !compact && 'border-navy/20 bg-blue-bg/50 rounded-md border px-3 py-2.5',
      )}
    >
      <span className="min-w-[min(200px,100%)] flex-1">
        <span
          className={cn('text-ink block font-semibold', compact ? 'text-[14px]' : 'text-[16px]')}
        >
          {list.name}
        </span>
        <span className="text-ink-3 block text-[13px]">
          {[
            t('prices.refList.from', { date: day(list.effectiveFrom) }),
            t('prices.refList.rows', { count: list.rows, n: formatNumber(list.rows) }),
            uploaded,
          ].join(' · ')}
        </span>
      </span>
      {list.status === 'current' &&
        (list.inEffect ? (
          <Badge tone="green">{t('prices.refList.inUse')}</Badge>
        ) : (
          <Badge tone="yellow">{t('prices.refList.from', { date: day(list.effectiveFrom) })}</Badge>
        ))}
      {list.status === 'past' && list.inEffect && (
        <Badge tone="blue">{t('prices.refList.inUseUntil')}</Badge>
      )}
    </div>
  )
}

/** The dry run: what the new list changes, before it is used. */
function PreviewPanel({
  preview,
  from,
  busy,
  error,
  onClose,
  onUse,
}: {
  preview: ReferencePreview
  from: string
  busy: boolean
  error: string | null
  onClose: () => void
  onUse: () => void
}) {
  const { t } = useTranslation()
  const tiles: { label: string; value: number; hue: Hue }[] = [
    { label: t('prices.refList.tile.new'), value: preview.new, hue: 'mint' },
    { label: t('prices.refList.tile.changed'), value: preview.changed.length, hue: 'amber' },
    { label: t('prices.refList.tile.removed'), value: preview.removed.length, hue: 'coral' },
    { label: t('prices.refList.tile.unchanged'), value: preview.unchanged, hue: 'teal' },
    { label: t('prices.refList.tile.errors'), value: preview.errors.length, hue: 'violet' },
  ]
  return (
    <SidePanel
      open
      onClose={onClose}
      hue="blue"
      icon={ListChecks}
      title={t('prices.refList.previewTitle', { name: preview.name })}
      subtitle={
        preview.current
          ? t('prices.refList.comparedWith', {
              name: preview.current.name,
              count: preview.current.rows,
            })
          : t('prices.refList.firstList')
      }
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('staff.form.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy || preview.rows === 0}
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
          {t('prices.refList.kept', { count: preview.rows, total: preview.total })}
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
            {t('prices.refList.changedTitle')}
          </h3>
          {preview.changed.length === 0 ? (
            <p className="text-ink-3 m-0 text-[13px]">{t('prices.refList.noChange')}</p>
          ) : (
            <ShownList items={preview.changed} step={15} footerClassName="pt-1">
              {(rows) => (
                <div className="border-border overflow-x-auto rounded-md border">
                  <table className="w-full border-collapse">
                    <thead className="bg-surface">
                      <tr>
                        <th className={tableHead}>{t('prices.refList.colMedicine')}</th>
                        <th className={cn(tableHead, 'text-right')}>
                          {t('prices.refList.colOld')}
                        </th>
                        <th className={cn(tableHead, 'text-right')}>
                          {t('prices.refList.colNew')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((c) => (
                        <tr key={c.code} className={tableRow}>
                          <td className={tableCell}>
                            <span className="block font-medium">{c.generic}</span>
                            <span className="text-ink-3 flex flex-wrap items-center gap-1 text-[12px]">
                              {[c.code, c.presentation].filter(Boolean).join(' · ')}
                              {c.inClinic && (
                                <Badge tone="blue">{t('prices.refList.atClinic')}</Badge>
                              )}
                            </span>
                          </td>
                          <td className={cn(tableCell, 'text-ink-3 text-right tabular-nums')}>
                            {price(c.old)}
                          </td>
                          <td
                            className={cn(
                              tableCell,
                              'text-right font-semibold tabular-nums',
                              c.new != null && c.old != null && c.new > c.old
                                ? 'text-red'
                                : 'text-green',
                            )}
                          >
                            {price(c.new)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </ShownList>
          )}
        </section>

        <section className="flex flex-col gap-1">
          <h3 className="text-ink m-0 text-[15px] font-semibold">
            {t('prices.refList.removedTitle')}
          </h3>
          {preview.removed.length === 0 ? (
            <p className="text-ink-3 m-0 text-[13px]">{t('prices.refList.noneRemoved')}</p>
          ) : (
            <>
              <p className="text-ink-3 m-0 text-[13px]">{t('prices.refList.removedHint')}</p>
              <ShownList items={preview.removed} step={10} footerClassName="pt-1">
                {(rows) =>
                  rows.map((r) => (
                    <Row key={r.code} className="flex-wrap gap-x-2 gap-y-1 px-0 py-1.5">
                      <span className="min-w-[180px] flex-1">
                        <span className="text-ink block text-[14px] font-medium">{r.generic}</span>
                        <span className="text-ink-3 text-[12px]">
                          {[r.code, r.presentation].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      {r.inClinic && <Badge tone="yellow">{t('prices.refList.atClinic')}</Badge>}
                    </Row>
                  ))
                }
              </ShownList>
            </>
          )}
        </section>

        {preview.errors.length > 0 && (
          <section className="flex flex-col gap-1">
            <h3 className="text-ink m-0 text-[15px] font-semibold">
              {t('prices.refList.errorsTitle')}
            </h3>
            <p className="text-ink-3 m-0 text-[13px]">{t('prices.refList.errorsHint')}</p>
            <ShownList items={preview.errors} step={10} footerClassName="pt-1">
              {(rows) =>
                rows.map((r, i) => (
                  <Row key={`${r.row}-${i}`} className="flex-wrap gap-x-2 gap-y-1 px-0 py-1.5">
                    <Badge tone="red">{t('prices.refList.rowN', { n: r.row })}</Badge>
                    <span className="text-ink text-[14px]">
                      {t(`prices.refList.err.${r.code}`, { defaultValue: r.message })}
                    </span>
                    {r.value && <span className="text-ink-3 text-[13px]">“{r.value}”</span>}
                  </Row>
                ))
              }
            </ShownList>
          </section>
        )}
      </div>
    </SidePanel>
  )
}
