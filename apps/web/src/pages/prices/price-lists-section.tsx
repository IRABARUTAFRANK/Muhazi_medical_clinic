import { useMemo, useRef, useState, type FormEvent } from 'react'
import { FileSpreadsheet, Library, ListChecks, ShieldCheck, Table2, Upload, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatNumber, isoDate } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Seg } from '@/components/ui/seg'
import { Select } from '@/components/ui/select'
import type { Insurer } from '@/lib/api/catalogue'
import {
  usePriceListImport,
  usePriceLists,
  type ListKind,
  type PriceListBook,
  type PriceListImportInput,
  type PriceListPreview,
} from '@/lib/api/price-lists'
import { useConfirm } from '@/lib/confirm'
import { PriceListFileError, readPriceListFile, type ParsedPriceList } from '@/lib/price-list-file'
import { cn } from '@/lib/utils'
import { day, errorBox } from './price-list-kit'
import { PriceListPreviewPanel } from './price-list-preview'
import { FollowersPanel, LinesPanel } from './price-list-lines'

const ACCEPT =
  '.xlsx,.csv,.pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,application/pdf'
/** The upload makes a new list. */
const NEW = ''

/**
 * Published price lists (Prices, after the official medicine list): the tariffs of treatments and
 * of medicines the Ministry of Health, RSSB / RHIA and the insurers publish. Each list shows its
 * version in use, the insurers that follow it (their price column) and how many of the clinic's
 * treatments or medicines are on it; "See the lines" opens the lines (edit one, add one, take
 * one out, an insurer's exceptions), "Insurers" says which insurers follow it and with which
 * column. The upload reads an Excel file, a CSV or a PDF, keeps every price column, and "Check
 * the list" shows everything that changes before "Keep this list from …".
 */
export function PriceListsSection({
  insurers,
  onNotice,
}: {
  insurers: Insurer[]
  onNotice: (text: string) => void
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { data: books = [], error: listError } = usePriceLists()
  const actions = usePriceListImport()
  const fileInput = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [parsed, setParsed] = useState<ParsedPriceList | null>(null)
  const [reading, setReading] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [target, setTarget] = useState(NEW)
  const [bookName, setBookName] = useState('')
  const [publisher, setPublisher] = useState('')
  const [kind, setKind] = useState<ListKind>('treatments')
  const [name, setName] = useState('')
  const [from, setFrom] = useState(() => isoDate(new Date()))
  const [instructionsOf, setInstructionsOf] = useState('')
  /** The names suggested for the last file read (replaced when another file is chosen). */
  const suggested = useRef({ name: '', book: '' })
  const [preview, setPreview] = useState<PriceListPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [linesOf, setLinesOf] = useState<PriceListBook | null>(null)
  const [followersOf, setFollowersOf] = useState<PriceListBook | null>(null)
  const insurerList = insurers
  const book = books.find((b) => b.id === target) ?? null
  const current = book?.versions.find((v) => v.status === 'current') ?? null
  const noteColumn = parsed?.roles.find((r) => r.role === 'note')?.label ?? null
  const grouped = useMemo(
    () =>
      (['treatments', 'medicines'] as const).map((k) => ({
        kind: k,
        books: books.filter((b) => b.kind === k),
      })),
    [books],
  )

  const reset = () => {
    setPreview(null)
    setError(null)
  }
  /** The wrong file: forget it and what was read from it. */
  const removeFile = () => {
    reset()
    setFileError(null)
    setParsed(null)
    setFile(null)
    setInstructionsOf('')
    if (fileInput.current) fileInput.current.value = ''
  }

  const choose = async (f: File | null) => {
    reset()
    setFileError(null)
    setParsed(null)
    setFile(f)
    // whose instructions: said again for each file
    setInstructionsOf('')
    if (!f) return
    setReading(true)
    try {
      const p = await readPriceListFile(f)
      setParsed(p)
      const base = f.name.replace(/\.[a-z0-9]+$/i, '')
      // a name typed by hand stays; one suggested for the previous file is suggested again
      const nextName = (p.title ?? base).slice(0, 120)
      if (!name.trim() || name === suggested.current.name) setName(nextName)
      if (target === NEW && (!bookName.trim() || bookName === suggested.current.book))
        setBookName(base.slice(0, 120))
      suggested.current = { name: nextName, book: base.slice(0, 120) }
      if (p.kind && target === NEW) setKind(p.kind)
      // the month the file says; otherwise today (not the date of the previous file)
      setFrom(p.from ?? isoDate(new Date()))
    } catch (e) {
      const problem = e instanceof PriceListFileError ? e.problem : 'unreadable'
      setFileError(t(`prices.lists.fileErr.${problem}`))
    } finally {
      setReading(false)
    }
  }

  const input = (): PriceListImportInput => ({
    bookId: target || null,
    book: target ? null : { name: bookName.trim(), publisher: publisher.trim(), kind },
    name: name.trim(),
    effectiveFrom: from,
    columns: parsed?.columns ?? [],
    lines: parsed?.lines ?? [],
    instructionsPayerId: instructionsOf || null,
    fileName: file?.name ?? null,
    notes: parsed?.notes ?? [],
  })

  const check = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!parsed || !name.trim() || !from || (!target && (!bookName.trim() || !publisher.trim()))) {
      setError(t('prices.lists.needAll'))
      return
    }
    try {
      setPreview(await actions.check.mutateAsync(input()))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const keep = async () => {
    if (!preview) return
    if (
      !(await confirm({
        title: t('prices.lists.confirmTitle', { name: preview.name, date: day(from) }),
        body: t('prices.lists.confirmBody', {
          count: preview.rows,
          list: preview.book.name,
        }),
        confirmLabel: t('prices.lists.confirmYes'),
      }))
    )
      return
    setError(null)
    try {
      const r = await actions.apply.mutateAsync(input())
      removeFile()
      setName('')
      setBookName('')
      setPublisher('')
      setTarget(NEW)
      onNotice(
        [
          t('prices.lists.done', { name: r.name, list: r.book.name, date: day(r.effectiveFrom) }),
          r.clinic.linked > 0 ? t('prices.lists.doneLinked', { count: r.clinic.linked }) : '',
          r.instructions
            ? t('prices.lists.doneExceptions', {
                payer: r.instructions.payer,
                count: r.instructions.notCovered + r.instructions.preauth + r.instructions.notes,
              })
            : '',
        ]
          .filter(Boolean)
          .join(' '),
      )
    } catch (err) {
      setPreview(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const newVersionOf = (b: PriceListBook) => {
    setTarget(b.id)
    setKind(b.kind)
    reset()
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader icon={Library} hue="violet">
        <span className="min-w-0 flex-1">{t('prices.lists.title')}</span>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        <p className="text-ink-2 m-0 text-[14px]">{t('prices.lists.lead')}</p>
        {listError && (
          <p role="alert" className={errorBox}>
            {listError.message}
          </p>
        )}
        {books.length === 0 && !listError && (
          <p className="text-ink-3 m-0 text-[14px]">{t('prices.lists.none')}</p>
        )}
        {grouped.map(
          (g) =>
            g.books.length > 0 && (
              <section key={g.kind} className="flex flex-col gap-2">
                <h3 className="text-ink m-0 text-[15px] font-semibold">
                  {t(`prices.lists.kinds.${g.kind}`)}
                </h3>
                {g.books.map((b) => (
                  <BookRow
                    key={b.id}
                    book={b}
                    onLines={() => setLinesOf(b)}
                    onFollowers={() => setFollowersOf(b)}
                    onNewVersion={() => newVersionOf(b)}
                  />
                ))}
              </section>
            ),
        )}
      </CardBody>

      <form
        ref={formRef}
        onSubmit={(e) => void check(e)}
        className="border-border bg-surface/60 flex scroll-mt-4 flex-col gap-3 border-t px-4 py-3"
      >
        <span className="text-violet inline-flex items-center gap-2 text-[15px] font-semibold">
          <Upload size={16} aria-hidden="true" />
          {t('prices.lists.upload')}
        </span>
        <div className="flex flex-col gap-1">
          <span className="text-ink-2 text-[13px] font-medium">{t('prices.lists.file')}</span>
          <div className="flex items-stretch gap-2">
            <label
              className={cn(
                'border-border bg-card hover:border-violet/40 flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md border border-dashed px-3 py-2.5',
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
              <span className="bg-violet-bg text-violet grid size-10 flex-none place-items-center rounded-md">
                <FileSpreadsheet size={20} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-ink block text-[14px] font-semibold wrap-break-word">
                  {reading ? t('prices.lists.reading') : file?.name || t('prices.lists.choose')}
                </span>
                <span className="text-ink-3 block text-[13px]">
                  {file ? t('prices.lists.fileChange') : t('prices.lists.fileHint')}
                </span>
              </span>
            </label>
            {file && !reading && (
              <Button
                type="button"
                variant="tint-grey"
                className="h-auto self-stretch"
                onClick={removeFile}
                title={t('prices.lists.removeFile')}
              >
                <X size={16} aria-hidden="true" />
                <span className="max-[480px]:sr-only">{t('prices.lists.removeFile')}</span>
              </Button>
            )}
          </div>
        </div>
        {fileError && (
          <p role="alert" className={errorBox}>
            {fileError}
          </p>
        )}
        {parsed && <ReadSummary parsed={parsed} fileName={file?.name ?? ''} />}

        {parsed && (
          <>
            <Select
              label={t('prices.lists.which')}
              value={target}
              onChange={(e) => {
                setTarget(e.target.value)
                const b = books.find((x) => x.id === e.target.value)
                if (b) setKind(b.kind)
                reset()
              }}
            >
              <option value={NEW}>{t('prices.lists.newList')}</option>
              {books.map((b) => (
                <option key={b.id} value={b.id}>
                  {t('prices.lists.newVersionOf', { name: b.name })}
                </option>
              ))}
            </Select>
            {target === NEW && (
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,220px)]">
                <Field
                  label={t('prices.lists.bookName')}
                  value={bookName}
                  maxLength={120}
                  placeholder={t('prices.lists.bookNamePh')}
                  onChange={(e) => {
                    setBookName(e.target.value)
                    reset()
                  }}
                />
                <Field
                  label={t('prices.lists.publisher')}
                  value={publisher}
                  maxLength={80}
                  list="price-list-publishers"
                  placeholder={t('prices.lists.publisherPh')}
                  onChange={(e) => {
                    setPublisher(e.target.value)
                    reset()
                  }}
                />
                <datalist id="price-list-publishers">
                  {[
                    'Ministry of Health (MoH)',
                    'RSSB',
                    'RHIA',
                    ...insurerList.map((i) => i.name),
                  ].map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
                <Seg
                  label={t('prices.lists.kind')}
                  value={kind}
                  onChange={(k) => {
                    setKind(k)
                    reset()
                  }}
                  options={[
                    { value: 'treatments', label: t('prices.lists.kinds.treatments') },
                    { value: 'medicines', label: t('prices.lists.kinds.medicines') },
                  ]}
                  className="self-start"
                />
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_200px]">
              <Field
                label={t('prices.lists.versionName')}
                value={name}
                maxLength={120}
                placeholder={t('prices.lists.versionNamePh')}
                onChange={(e) => {
                  setName(e.target.value)
                  reset()
                }}
              />
              <Field
                label={t('prices.lists.effective')}
                type="date"
                value={from}
                min={current?.effectiveFrom}
                onChange={(e) => {
                  setFrom(e.target.value)
                  reset()
                }}
              />
            </div>
            {noteColumn && (
              <Select
                label={t('prices.lists.instructionsOf', { column: noteColumn })}
                value={instructionsOf}
                onChange={(e) => {
                  setInstructionsOf(e.target.value)
                  reset()
                }}
              >
                <option value="">{t('prices.lists.instructionsNotes')}</option>
                {insurerList.map((i) => (
                  <option key={i.id} value={i.id}>
                    {t('prices.lists.instructionsInsurer', { name: i.name })}
                  </option>
                ))}
              </Select>
            )}
          </>
        )}
        {error && !preview && (
          <p role="alert" className={errorBox}>
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            variant="tint-violet"
            disabled={!parsed || reading || actions.check.isPending}
          >
            <ListChecks size={16} aria-hidden="true" />
            {actions.check.isPending ? t('prices.lists.checking') : t('prices.lists.check')}
          </Button>
          <span className="text-ink-3 text-[13px]">{t('prices.lists.checkNote')}</span>
        </div>
      </form>

      {preview && (
        <PriceListPreviewPanel
          preview={preview}
          from={from}
          busy={actions.apply.isPending}
          error={error}
          onClose={() => setPreview(null)}
          onKeep={() => void keep()}
        />
      )}
      {linesOf && (
        <LinesPanel
          book={books.find((b) => b.id === linesOf.id) ?? linesOf}
          insurers={insurerList}
          onClose={() => setLinesOf(null)}
          onNotice={onNotice}
        />
      )}
      {followersOf && (
        <FollowersPanel
          book={books.find((b) => b.id === followersOf.id) ?? followersOf}
          insurers={insurerList}
          onClose={() => setFollowersOf(null)}
          onNotice={onNotice}
        />
      )}
    </Card>
  )
}

/** What the reader found in the file: lines, where, the columns, the price columns, the notes. */
function ReadSummary({ parsed, fileName }: { parsed: ParsedPriceList; fileName: string }) {
  const { t } = useTranslation()
  const roles = parsed.roles.filter((r) => r.role !== 'price')
  return (
    <div className="border-violet/20 bg-violet-bg/50 flex flex-col gap-1.5 rounded-md border px-3 py-2 text-[13px]">
      <span className="text-ink font-semibold">
        {parsed.format === 'pdf'
          ? t('prices.lists.readPdf', {
              count: parsed.lines.length,
              n: formatNumber(parsed.lines.length),
              file: fileName,
            })
          : t('prices.lists.read', {
              count: parsed.lines.length,
              n: formatNumber(parsed.lines.length),
              row: parsed.headerRow,
              sheet: parsed.sheet ?? fileName,
            })}
        {parsed.kind && ` · ${t(`prices.lists.kinds.${parsed.kind}`)}`}
      </span>
      <span className="flex flex-wrap items-center gap-1">
        <span className="text-ink-2">{t('prices.lists.columnsFound')}</span>
        {roles.map((r) => (
          <Badge key={`${r.role}-${r.label}`} tone={r.role === 'number' ? 'grey' : 'green'}>
            {t(`prices.lists.role.${r.role}`)}
            {r.label && `: ${r.label}`}
          </Badge>
        ))}
      </span>
      <span className="flex flex-wrap items-center gap-1">
        <span className="text-ink-2">
          {t('prices.lists.priceColumns', { count: parsed.columns.length })}
        </span>
        {parsed.columns.map((c) => (
          <Badge key={c.key} tone="blue">
            {c.label}
          </Badge>
        ))}
      </span>
      {parsed.notes.length > 0 && (
        <span className="text-ink-2">
          {t('prices.lists.fileNotes')}{' '}
          <span className="text-ink">{parsed.notes.slice(0, 3).join(' · ')}</span>
        </span>
      )}
    </div>
  )
}

/** One list: its version in use, the insurers that follow it, what is on it, and its actions. */
function BookRow({
  book,
  onLines,
  onFollowers,
  onNewVersion,
}: {
  book: PriceListBook
  onLines: () => void
  onFollowers: () => void
  onNewVersion: () => void
}) {
  const { t } = useTranslation()
  const cur = book.versions.find((v) => v.status === 'current') ?? null
  const earlier = book.versions.length - 1
  const columnLabel = (key: string) => cur?.columns.find((c) => c.key === key)?.label ?? key
  return (
    <div className="border-border bg-card flex flex-col gap-2 rounded-md border px-3 py-2.5">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <span className="min-w-[min(220px,100%)] flex-1">
          <span className="text-ink block text-[16px] font-semibold wrap-anywhere">
            {book.name}
          </span>
          <span className="text-ink-3 block text-[13px] wrap-anywhere">
            {[
              book.publisher,
              cur ? cur.name : null,
              cur ? t('prices.lists.from', { date: day(cur.effectiveFrom) }) : null,
              cur ? t('prices.lists.rows', { count: cur.rows, n: formatNumber(cur.rows) }) : null,
              cur ? t('prices.lists.columnsN', { count: cur.columns.length }) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        {cur &&
          (cur.inEffect ? (
            <Badge tone="green">{t('prices.lists.inUse')}</Badge>
          ) : (
            <Badge tone="yellow">{t('prices.lists.from', { date: day(cur.effectiveFrom) })}</Badge>
          ))}
        {earlier > 0 && <Badge tone="grey">{t('prices.lists.earlier', { count: earlier })}</Badge>}
      </div>
      <div className="text-ink-2 flex flex-wrap items-center gap-1 text-[13px]">
        <ShieldCheck size={14} aria-hidden="true" className="text-ink-3" />
        {book.followers.length === 0 ? (
          <span className="text-ink-3">{t('prices.lists.noFollower')}</span>
        ) : (
          <>
            <span>{t('prices.lists.followedBy')}</span>
            {book.followers.map((f) => (
              <Badge key={f.payerId} tone="blue">
                {f.payer} · {columnLabel(f.column)}
              </Badge>
            ))}
          </>
        )}
      </div>
      <div className="text-ink-3 flex flex-wrap gap-x-3 text-[13px]">
        <span>
          {t(
            book.kind === 'medicines' ? 'prices.lists.linkedMeds' : 'prices.lists.linkedTreatments',
            {
              count: book.linked,
            },
          )}
        </span>
        {book.exceptions > 0 && (
          <span>{t('prices.lists.exceptionsN', { count: book.exceptions })}</span>
        )}
        {cur && cur.edited > 0 && <span>{t('prices.lists.editedN', { count: cur.edited })}</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="tint-violet" onClick={onLines} disabled={!cur}>
          <Table2 size={14} aria-hidden="true" />
          {t('prices.lists.seeLines')}
        </Button>
        <Button size="sm" variant="tint-blue" onClick={onFollowers} disabled={!cur}>
          <ShieldCheck size={14} aria-hidden="true" />
          {t('prices.lists.insurers')}
        </Button>
        <Button size="sm" variant="tint-grey" onClick={onNewVersion}>
          <Upload size={14} aria-hidden="true" />
          {t('prices.lists.newVersion')}
        </Button>
      </div>
    </div>
  )
}
