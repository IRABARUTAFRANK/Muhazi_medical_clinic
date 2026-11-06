import { useMemo, useRef, useState, type FormEvent } from 'react'
import {
  Building2,
  FileSpreadsheet,
  Library,
  ListChecks,
  Pill,
  Settings2,
  ShieldCheck,
  Stethoscope,
  Table2,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatNumber, isoDate } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Seg } from '@/components/ui/seg'
import { Select } from '@/components/ui/select'
import { payerBodyOf, type Insurer } from '@/lib/api/catalogue'
import {
  SCOPES,
  usePriceListActions,
  usePriceListImport,
  usePriceLists,
  type ListKind,
  type ListScope,
  type PriceListBook,
  type PriceListImportInput,
  type PriceListPreview,
} from '@/lib/api/price-lists'
import { useConfirm } from '@/lib/confirm'
import { PriceListFileError, readPriceListFile, type ParsedPriceList } from '@/lib/price-list-file'
import { DOCUMENT_ACCEPT } from '@/lib/document-grids'
import { cn } from '@/lib/utils'
import {
  day,
  errorBox,
  guessFollowColumn,
  guessPayerColumn,
  guessPrivateColumn,
  looksRssb,
  useRemoveList,
} from './price-list-kit'
import { ColumnsCheck } from './price-list-columns'
import { FileCheck } from './price-list-file-check'
import { PriceListPreviewPanel } from './price-list-preview'
import { FollowersPanel, LinesPanel } from './price-list-lines'
import { BookSettingsPanel } from './price-list-settings'

/** Every kind of file a price list may come in (Excel, CSV, PDF, Word, OpenDocument, a web page). */
const ACCEPT = DOCUMENT_ACCEPT
/** The upload makes a new list. */
const NEW = ''
const MOH = 'Ministry of Health (MoH)'

/**
 * Published price lists (Prices): the tariffs of treatments and of medicines published by the
 * Ministry of Health (for the whole clinic: private patients pay its private column, and a list of
 * treatments makes every line a treatment of the clinic), by an insurer (its own tariff: that
 * insurer pays it at once), or by another publisher (insurers choose to follow it). Two tabs, two
 * uploads: Treatments & services, and Medicines & products. A file in any form (Excel, CSV, a PDF
 * with text) is read, its columns can be corrected, and "Check the list" shows everything that
 * changes before "Keep this list from …".
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
  const bookActions = usePriceListActions()
  const fileInput = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const [tab, setTab] = useState<ListKind>('treatments')
  const [file, setFile] = useState<File | null>(null)
  const [parsed, setParsed] = useState<ParsedPriceList | null>(null)
  const [reading, setReading] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [target, setTarget] = useState(NEW)
  const [scope, setScope] = useState<ListScope>('clinic')
  const [payerId, setPayerId] = useState('')
  const [bookName, setBookName] = useState('')
  const [publisher, setPublisher] = useState('')
  const [name, setName] = useState('')
  const [from, setFrom] = useState(() => isoDate(new Date()))
  const [privateColumn, setPrivateColumn] = useState('')
  const [payerColumn, setPayerColumn] = useState('')
  const [instructionsOf, setInstructionsOf] = useState('')
  /** A new list: the column each insurer pays ('' : it does not use the list). */
  const [follow, setFollow] = useState<Record<string, string>>({})
  const removeList = useRemoveList(onNotice)
  /** The names suggested for the last file read (replaced when another file is chosen). */
  const suggested = useRef({ name: '', book: '' })
  /** The file being read: a read the manager no longer waits for is dropped. */
  const readToken = useRef(0)
  /** The name of the file read (it may say the list is RSSB's). */
  const fileName = useRef('')
  const [preview, setPreview] = useState<PriceListPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [linesOf, setLinesOf] = useState<PriceListBook | null>(null)
  const [followersOf, setFollowersOf] = useState<PriceListBook | null>(null)
  const [settingsOf, setSettingsOf] = useState<PriceListBook | null>(null)
  const tabBooks = useMemo(() => books.filter((b) => b.kind === tab), [books, tab])
  const book = books.find((b) => b.id === target) ?? null
  const current = book?.versions.find((v) => v.status === 'current') ?? null
  const effScope: ListScope = book?.scope ?? scope
  const insurer = insurers.find((i) => i.id === (book?.payerId ?? payerId))
  /**
   * RSSB's list (0137): its insurer is one of RSSB's schemes, so it is the tariff of every RSSB
   * scheme (RAMA and Mutuelle de santé): they all follow it, pay its column, get its instructions.
   */
  const ownerBody = effScope === 'insurer' ? (book?.payerBody ?? payerBodyOf(insurer?.type)) : null
  const bodyOwners = ownerBody ? insurers.filter((i) => payerBodyOf(i.type) === ownerBody) : []
  const ownersLabel =
    bodyOwners.length > 1
      ? bodyOwners.map((i) => i.name).join(', ')
      : (insurer?.name ?? book?.payer ?? '')
  /** The file says it is RSSB's list ("… BY RSSB JUNE 2026"). */
  const rssbFile = !!parsed && looksRssb(parsed.title, file?.name, publisher)
  const rssbInsurer =
    insurers.find((i) => i.type === 'rssb_rama') ??
    insurers.find((i) => payerBodyOf(i.type) === 'RSSB')
  const columns = parsed?.columns ?? []
  const noteColumn = parsed?.layout.find((c) => c.role === 'note')?.label ?? null
  /** The insurers that may pay a list (the active ones). */
  const payers = insurers
  /** The insurer has its own list of this kind (it does not use another one unless chosen). */
  const hasOwnList = (payerId: string) => {
    const body = payerBodyOf(insurers.find((i) => i.id === payerId)?.type)
    return books.some(
      (b) =>
        b.scope === 'insurer' &&
        b.kind === tab &&
        (b.payerId === payerId || (!!body && b.payerBody === body)),
    )
  }
  const choosingFollowers = target === NEW && effScope !== 'insurer' && columns.length > 0
  /** The column the patients pay: the private column, or the insurer's own column. */
  const mainColumn =
    effScope === 'clinic'
      ? privateColumn
      : effScope === 'insurer'
        ? payerColumn || (columns.length === 1 ? columns[0]!.key : '')
        : ''
  const mainLabel = effScope === 'clinic' ? t('prices.lists.fc.privatePatients') : ownersLabel
  /** Who pays each column, for "Compare with the file". */
  const uses: Record<string, string[]> = {}
  const addUse = (key: string | null | undefined, who: string) => {
    if (key && who) (uses[key] ??= []).push(who)
  }
  addUse(mainColumn, mainLabel)
  if (choosingFollowers) for (const i of payers) addUse(follow[i.id], i.name)
  else if (book)
    for (const f of book.followers)
      if (!(
        effScope === 'insurer' &&
        (f.payerId === book.payerId || (!!book.payerBody && f.body === book.payerBody))
      ))
        addUse(f.column, f.payer)
  const grouped = useMemo(
    () =>
      SCOPES.map((s) => ({ scope: s, books: tabBooks.filter((b) => b.scope === s) })).filter(
        (g) => g.books.length > 0,
      ),
    [tabBooks],
  )

  const reset = () => {
    setPreview(null)
    setError(null)
  }
  /** The wrong file: forget it and what was read from it. */
  const removeFile = () => {
    readToken.current++
    reset()
    setFileError(null)
    setParsed(null)
    setFile(null)
    setInstructionsOf('')
    if (fileInput.current) fileInput.current.value = ''
  }
  /** The columns of the file (read, or corrected): the private and the insurer's column again. */
  const applyColumns = (p: ParsedPriceList, b: PriceListBook | null = book, keep = true) => {
    const keys = p.columns.map((c) => c.key)
    setPrivateColumn((cur) =>
      b?.privateColumn && keys.includes(b.privateColumn)
        ? b.privateColumn
        : keep && cur && keys.includes(cur)
          ? cur
          : guessPrivateColumn(p.columns),
    )
    const own = b?.followers.find((f) => f.payerId === b.payerId)?.column
    const ins = insurers.find((i) => i.id === (b?.payerId ?? payerId))
    setPayerColumn((cur) =>
      own && keys.includes(own)
        ? own
        : keep && cur && keys.includes(cur)
          ? cur
          : guessPayerColumn(p.columns, ins?.name),
    )
    // the column each insurer pays: what was chosen stays, the others are guessed from the names
    setFollow((cur) =>
      Object.fromEntries(
        payers.map((i) => {
          const was = cur[i.id]
          if (keep && was !== undefined && (was === '' || keys.includes(was))) return [i.id, was]
          const rssb = looksRssb(p.title, fileName.current, publisher)
          return [i.id, hasOwnList(i.id) ? '' : guessFollowColumn(p.columns, i, rssb)]
        }),
      ),
    )
  }

  const choose = async (f: File | null) => {
    removeFile()
    const token = ++readToken.current
    fileName.current = f?.name ?? ''
    setFile(f)
    if (!f) return
    setReading(true)
    try {
      const p = await readPriceListFile(f)
      if (token !== readToken.current) return
      setParsed(p)
      const base = f.name.replace(/\.[a-z0-9]+$/i, '')
      // a name typed by hand stays; one suggested for the previous file is suggested again
      const nextName = (p.title ?? base).slice(0, 120)
      if (!name.trim() || name === suggested.current.name) setName(nextName)
      if (target === NEW && (!bookName.trim() || bookName === suggested.current.book))
        setBookName(base.slice(0, 120))
      suggested.current = { name: nextName, book: base.slice(0, 120) }
      // the month the file says; otherwise today (not the date of the previous file)
      setFrom(p.from ?? isoDate(new Date()))
      applyColumns(p, book, false)
      const owner = book?.payerId ?? payerId
      if (effScope === 'insurer' && owner && p.layout.some((c) => c.role === 'note'))
        setInstructionsOf(owner)
    } catch (e) {
      if (token !== readToken.current) return
      const problem = e instanceof PriceListFileError ? e.problem : 'unreadable'
      setFileError(t(`prices.lists.fileErr.${problem}`))
    } finally {
      setReading(false)
    }
  }

  const switchTab = (k: ListKind) => {
    if (k === tab) return
    setTab(k)
    setTarget(NEW)
    removeFile()
  }

  const newVersionOf = (b: PriceListBook) => {
    setTab(b.kind)
    setTarget(b.id)
    reset()
    if (parsed) applyColumns(parsed, b)
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const publisherOf = () =>
    effScope === 'insurer'
      ? ownerBody
        ? ownerBody
        : (insurer?.name ?? '')
      : publisher.trim() || (effScope === 'clinic' ? MOH : '')

  const input = (): PriceListImportInput => ({
    bookId: target || null,
    book: target
      ? null
      : {
          name: bookName.trim(),
          publisher: publisherOf(),
          kind: tab,
          scope,
          payerId: scope === 'insurer' ? payerId || null : null,
          privateColumn: scope === 'clinic' ? privateColumn || null : null,
          payerColumn: scope === 'insurer' ? payerColumn || null : null,
        },
    settings: target
      ? {
          privateColumn: effScope === 'clinic' ? privateColumn || null : null,
          payerColumn: effScope === 'insurer' ? payerColumn || null : null,
        }
      : null,
    name: name.trim(),
    effectiveFrom: from,
    columns,
    lines: parsed?.lines ?? [],
    instructionsPayerId: noteColumn ? instructionsOf || null : null,
    fileName: file?.name ?? null,
    notes: parsed?.notes ?? [],
  })

  const check = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!parsed || !name.trim() || !from || (!target && !bookName.trim()))
      return setError(t('prices.lists.needAll'))
    if (effScope === 'insurer' && !(book?.payerId ?? payerId))
      return setError(t('prices.lists.needInsurer'))
    if (effScope === 'clinic' && !privateColumn) return setError(t('prices.lists.needPrivate'))
    if (!target && !publisherOf()) return setError(t('prices.lists.needAll'))
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
        body: [
          t('prices.lists.confirmBody', { count: preview.rows, list: preview.book.name }),
          preview.clinic.toCreate > 0
            ? t('prices.lists.confirmCreate', { count: preview.clinic.toCreate })
            : '',
        ]
          .filter(Boolean)
          .join(' '),
        confirmLabel: t('prices.lists.confirmYes'),
      }))
    )
      return
    setError(null)
    // a new list: the insurers that pay one of its columns follow it once it is kept
    const followers = choosingFollowers && target === NEW ? payers.filter((i) => follow[i.id]) : []
    try {
      const r = await actions.apply.mutateAsync(input())
      const followed: string[] = []
      const failed: string[] = []
      if (r.bookId)
        for (const i of followers) {
          try {
            await bookActions.follow.mutateAsync({
              payerId: i.id,
              payer: i.name,
              bookId: r.bookId,
              column: follow[i.id]!,
              priority: null,
            })
            followed.push(i.name)
          } catch (e) {
            failed.push(`${i.name} (${e instanceof Error ? e.message : String(e)})`)
          }
        }
      removeFile()
      setName('')
      setBookName('')
      setPublisher('')
      setTarget(NEW)
      onNotice(
        [
          t('prices.lists.done', { name: r.name, list: r.book.name, date: day(r.effectiveFrom) }),
          followed.length > 0
            ? t('prices.lists.pay.done', { count: followed.length, names: followed.join(', ') })
            : '',
          failed.length > 0 ? t('prices.lists.pay.failed', { names: failed.join('; ') }) : '',
          r.clinic.created > 0 ? t('prices.lists.doneCreated', { count: r.clinic.created }) : '',
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

  const listPricesForAll = async (b: PriceListBook) => {
    if (
      !(await confirm({
        title: t('prices.lists.useListAllQ', { count: b.ownPriced, list: b.name }),
        body: t('prices.lists.useListAllBody'),
        confirmLabel: t('prices.lists.useListAllYes'),
      }))
    )
      return
    try {
      const n = await bookActions.applyListPrices.mutateAsync({ bookId: b.id, ids: null })
      onNotice(t('prices.lists.useListDone', { count: n, list: b.name }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** "Remove the list": the list goes with the treatments it made (asked first). */
  /** "Remove every list": start again (every list goes with what it made, as one by one). */
  const removeAll = async () => {
    const n = books.length
    if (n === 0) return
    if (
      !(await confirm({
        title: t('prices.lists.dropAll.q', { count: n }),
        body: t('prices.lists.dropAll.body', {
          treatments: books.filter((b) => b.kind === 'treatments').length,
          medicines: books.filter((b) => b.kind === 'medicines').length,
        }),
        confirmLabel: t('prices.lists.dropAll.yes'),
        tone: 'danger',
      }))
    )
      return
    setError(null)
    let deleted = 0
    let hidden = 0
    let done = 0
    for (const b of books) {
      try {
        const r = await bookActions.removeBook.mutateAsync(b.id)
        deleted += r.deleted
        hidden += r.hidden
        done++
      } catch (e) {
        setError(`${b.name}: ${e instanceof Error ? e.message : String(e)}`)
        break
      }
    }
    setTarget(NEW)
    setLinesOf(null)
    setFollowersOf(null)
    setSettingsOf(null)
    reset()
    onNotice(t('prices.lists.dropAll.done', { count: done, deleted, hidden }))
  }

  const remove = async (b: PriceListBook) => {
    setError(null)
    try {
      if (!(await removeList.run(b))) return
      if (target === b.id) {
        setTarget(NEW)
        reset()
      }
      if (linesOf?.id === b.id) setLinesOf(null)
      if (followersOf?.id === b.id) setFollowersOf(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const scopeLabel = (s: ListScope) => t(`prices.lists.scope.${s}`)

  return (
    <Card className="overflow-hidden">
      <CardHeader icon={Library} hue="violet">
        <span className="min-w-0 flex-1">{t('prices.lists.title')}</span>
        {books.length > 0 && (
          <Button
            size="sm"
            variant="tint-coral"
            disabled={bookActions.removeBook.isPending}
            onClick={() => void removeAll()}
          >
            <Trash2 size={14} aria-hidden="true" />
            {t('prices.lists.dropAll.button')}
          </Button>
        )}
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        <p className="text-ink-2 m-0 text-[14px]">{t('prices.lists.lead')}</p>
        <Seg
          label={t('prices.lists.tabLabel')}
          value={tab}
          onChange={switchTab}
          options={[
            {
              value: 'treatments',
              label: t('prices.lists.tabTreatments', {
                count: books.filter((b) => b.kind === 'treatments').length,
              }),
            },
            {
              value: 'medicines',
              label: t('prices.lists.tabMedicines', {
                count: books.filter((b) => b.kind === 'medicines').length,
              }),
            },
          ]}
          className="self-start"
        />
        <p className="text-ink-3 m-0 text-[13px]">{t(`prices.lists.tabHint.${tab}`)}</p>
        {listError && (
          <p role="alert" className={errorBox}>
            {listError.message}
          </p>
        )}
        {error && !preview && !parsed && (
          <p role="alert" className={errorBox}>
            {error}
          </p>
        )}
        {tabBooks.length === 0 && !listError && (
          <p className="text-ink-3 m-0 text-[14px]">{t(`prices.lists.noneOf.${tab}`)}</p>
        )}
        {grouped.map((g) => (
          <section key={g.scope} className="flex flex-col gap-2">
            <h3 className="text-ink m-0 inline-flex items-center gap-2 text-[15px] font-semibold">
              {g.scope === 'clinic' ? (
                <Building2 size={16} aria-hidden="true" className="text-violet" />
              ) : g.scope === 'insurer' ? (
                <ShieldCheck size={16} aria-hidden="true" className="text-navy-ink" />
              ) : (
                <Library size={16} aria-hidden="true" className="text-ink-3" />
              )}
              {t(`prices.lists.scopeTitle.${g.scope}`)}
            </h3>
            {g.books.map((b) => (
              <BookRow
                key={b.id}
                book={b}
                onLines={() => setLinesOf(b)}
                onFollowers={() => setFollowersOf(b)}
                onSettings={() => setSettingsOf(b)}
                onNewVersion={() => newVersionOf(b)}
                onListPrices={() => void listPricesForAll(b)}
                onRemove={() => void remove(b)}
                removing={removeList.busy}
              />
            ))}
          </section>
        ))}
      </CardBody>

      <form
        ref={formRef}
        onSubmit={(e) => void check(e)}
        className="border-border bg-surface/60 flex scroll-mt-4 flex-col gap-3 border-t px-4 py-3"
      >
        <span className="text-violet inline-flex items-center gap-2 text-[15px] font-semibold">
          {tab === 'treatments' ? (
            <Stethoscope size={16} aria-hidden="true" />
          ) : (
            <Pill size={16} aria-hidden="true" />
          )}
          {t(`prices.lists.uploadOf.${tab}`)}
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
        {parsed && parsed.kind && parsed.kind !== tab && (
          <p className="border-amber/30 bg-amber-bg text-amber m-0 rounded-md border px-3 py-2 text-[13px] font-medium">
            {t(`prices.lists.looksLike.${parsed.kind}`)}
          </p>
        )}
        {parsed && (
          <ColumnsCheck
            parsed={parsed}
            fileName={file?.name ?? ''}
            insurers={insurers}
            onChange={(p) => {
              setParsed(p)
              applyColumns(p)
              reset()
            }}
          />
        )}

        {parsed && (
          <>
            <Select
              label={t('prices.lists.which')}
              value={target}
              onChange={(e) => {
                const b = books.find((x) => x.id === e.target.value) ?? null
                setTarget(e.target.value)
                applyColumns(parsed, b)
                reset()
              }}
            >
              <option value={NEW}>{t('prices.lists.newList')}</option>
              {tabBooks.map((b) => (
                <option key={b.id} value={b.id}>
                  {t('prices.lists.newVersionOf', { name: b.name })}
                </option>
              ))}
            </Select>

            {target === NEW ? (
              <>
                <Seg
                  label={t('prices.lists.whose')}
                  value={scope}
                  onChange={(s) => {
                    setScope(s)
                    reset()
                  }}
                  options={SCOPES.map((s) => ({ value: s, label: scopeLabel(s) }))}
                  className="self-start"
                />
                <p className="text-ink-3 m-0 -mt-1 text-[13px]">
                  {t(`prices.lists.scopeHint.${scope}.${tab}`)}
                </p>
                {rssbFile && scope !== 'insurer' && (
                  <div className="border-navy-ink/20 bg-blue-bg/50 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-[13px]">
                    <ShieldCheck size={15} aria-hidden="true" className="text-navy-ink flex-none" />
                    <span className="text-ink min-w-0 flex-1">{t('prices.lists.rssb.looks')}</span>
                    {rssbInsurer ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="tint-blue"
                        onClick={() => {
                          setScope('insurer')
                          setPayerId(rssbInsurer.id)
                          setPayerColumn(guessPayerColumn(parsed.columns, rssbInsurer.name))
                          if (noteColumn) setInstructionsOf(rssbInsurer.id)
                          reset()
                        }}
                      >
                        {t('prices.lists.rssb.make')}
                      </Button>
                    ) : (
                      <span className="text-ink-3">{t('prices.lists.rssb.noneActive')}</span>
                    )}
                  </div>
                )}
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,240px)]">
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
                  {scope === 'insurer' ? (
                    <Select
                      label={t('prices.lists.insurer')}
                      value={payerId}
                      onChange={(e) => {
                        setPayerId(e.target.value)
                        const ins = insurers.find((i) => i.id === e.target.value)
                        setPayerColumn(guessPayerColumn(parsed.columns, ins?.name))
                        if (e.target.value && noteColumn) setInstructionsOf(e.target.value)
                        reset()
                      }}
                    >
                      <option value="">{t('prices.lists.pickInsurer')}</option>
                      {insurers.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Field
                      label={t('prices.lists.publisher')}
                      value={publisher}
                      maxLength={80}
                      list="price-list-publishers"
                      placeholder={scope === 'clinic' ? MOH : t('prices.lists.publisherPh')}
                      onChange={(e) => {
                        setPublisher(e.target.value)
                        reset()
                      }}
                    />
                  )}
                  {scope === 'insurer' && ownerBody && (
                    <p className="text-navy-ink m-0 inline-flex items-start gap-1.5 text-[13px] sm:col-span-2">
                      <ShieldCheck size={14} aria-hidden="true" className="mt-0.5 flex-none" />
                      {t('prices.lists.rssb.shared', { names: ownersLabel })}
                    </p>
                  )}
                  <datalist id="price-list-publishers">
                    {[MOH, 'RSSB', 'RHIA', ...insurers.map((i) => i.name)].map((p) => (
                      <option key={p} value={p} />
                    ))}
                  </datalist>
                </div>
              </>
            ) : (
              <p className="text-ink-2 m-0 text-[13px]">
                <Badge
                  tone={effScope === 'clinic' ? 'blue' : effScope === 'insurer' ? 'green' : 'grey'}
                >
                  {effScope === 'insurer' && book?.payerBody
                    ? t('prices.lists.rssb.scope')
                    : effScope === 'insurer' && book?.payer
                      ? t('prices.lists.scopeOf', { payer: book.payer })
                      : scopeLabel(effScope)}
                </Badge>
                {book?.payerBody && (
                  <span className="text-navy-ink mt-1 block">
                    {t('prices.lists.rssb.shared', { names: ownersLabel })}
                  </span>
                )}
              </p>
            )}

            {effScope === 'clinic' && columns.length > 0 && (
              <Select
                label={t('prices.lists.privateColumn')}
                value={privateColumn}
                onChange={(e) => {
                  setPrivateColumn(e.target.value)
                  reset()
                }}
              >
                {columns.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </Select>
            )}
            {effScope === 'insurer' && columns.length > 1 && (
              <Select
                label={t('prices.lists.payerColumn', { payer: insurer?.name ?? '' })}
                value={payerColumn}
                onChange={(e) => {
                  setPayerColumn(e.target.value)
                  reset()
                }}
              >
                {columns.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </Select>
            )}
            {choosingFollowers && payers.length > 0 && (
              <fieldset className="border-border m-0 flex min-w-0 flex-col gap-2 rounded-md border px-3 pt-1 pb-3">
                <legend className="text-ink inline-flex items-center gap-1.5 px-1 text-[14px] font-semibold">
                  <ShieldCheck size={15} aria-hidden="true" className="text-navy-ink" />
                  {t('prices.lists.pay.title')}
                </legend>
                <p className="text-ink-3 m-0 text-[13px]">{t('prices.lists.pay.hint')}</p>
                <div className="grid gap-x-3 gap-y-2 sm:grid-cols-2">
                  {payers.map((i) => (
                    <Select
                      key={i.id}
                      label={
                        hasOwnList(i.id) ? t('prices.lists.pay.ownList', { name: i.name }) : i.name
                      }
                      value={follow[i.id] ?? ''}
                      onChange={(e) => {
                        setFollow((f) => ({ ...f, [i.id]: e.target.value }))
                        reset()
                      }}
                    >
                      <option value="">{t('prices.lists.pay.none')}</option>
                      {columns.map((c) => (
                        <option key={c.key} value={c.key}>
                          {c.label}
                        </option>
                      ))}
                    </Select>
                  ))}
                </div>
              </fieldset>
            )}
            <FileCheck parsed={parsed} uses={uses} mainColumn={mainColumn} mainLabel={mainLabel} />

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
                {insurers.map((i) => (
                  <option key={i.id} value={i.id}>
                    {t('prices.lists.instructionsInsurer', { name: i.name })}
                  </option>
                ))}
              </Select>
            )}
            {noteColumn &&
              ownerBody &&
              payerBodyOf(insurers.find((i) => i.id === instructionsOf)?.type) === ownerBody && (
                <p className="text-ink-3 m-0 -mt-1 text-[13px]">
                  {t('prices.lists.rssb.instructions', { names: ownersLabel })}
                </p>
              )}
          </>
        )}
        {error && !preview && parsed && (
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
          payers={bodyOwners.length > 1 ? ownersLabel : null}
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
          insurers={insurers}
          onClose={() => setLinesOf(null)}
          onNotice={onNotice}
        />
      )}
      {followersOf && (
        <FollowersPanel
          book={books.find((b) => b.id === followersOf.id) ?? followersOf}
          insurers={insurers}
          onClose={() => setFollowersOf(null)}
          onNotice={onNotice}
        />
      )}
      {settingsOf && (
        <BookSettingsPanel
          book={books.find((b) => b.id === settingsOf.id) ?? settingsOf}
          onClose={() => setSettingsOf(null)}
          onNotice={onNotice}
        />
      )}
    </Card>
  )
}

/** One list: whose it is, its version in use, who follows it, what is on it, and its actions. */
function BookRow({
  book,
  onLines,
  onFollowers,
  onSettings,
  onNewVersion,
  onListPrices,
  onRemove,
  removing,
}: {
  book: PriceListBook
  onLines: () => void
  onFollowers: () => void
  onSettings: () => void
  onNewVersion: () => void
  onListPrices: () => void
  onRemove: () => void
  removing: boolean
}) {
  const { t } = useTranslation()
  const cur = book.versions.find((v) => v.status === 'current') ?? null
  const earlier = book.versions.length - 1
  const columnLabel = (key: string | null) =>
    (key && cur?.columns.find((c) => c.key === key)?.label) || key || ''
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
      {book.scope === 'clinic' && (
        <div className="text-ink-2 flex flex-wrap items-center gap-1 text-[13px]">
          <Building2 size={14} aria-hidden="true" className="text-violet" />
          <span>
            {t('prices.lists.privatePays', { column: columnLabel(book.privateColumn) })} ·{' '}
            {t('prices.lists.orderN', { n: book.priority })}
          </span>
        </div>
      )}
      {book.scope === 'insurer' && book.payerBody && (
        <div className="text-navy-ink flex flex-wrap items-center gap-1 text-[13px] font-medium">
          <ShieldCheck size={14} aria-hidden="true" />
          <span>
            {t('prices.lists.rssb.bookLine', {
              names:
                book.followers
                  .filter((f) => f.body === book.payerBody)
                  .map((f) => f.payer)
                  .join(', ') ||
                book.payer ||
                '',
            })}
          </span>
        </div>
      )}
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
      <div className="text-ink-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <span>
          {t(
            book.kind === 'medicines' ? 'prices.lists.linkedMeds' : 'prices.lists.linkedTreatments',
            { count: book.linked },
          )}
        </span>
        {book.scope === 'clinic' && book.ownPriced > 0 && (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <span className="text-amber font-medium">
              {t('prices.lists.ownPricedN', { count: book.ownPriced })}
            </span>
            <Button size="sm" variant="tint-amber" onClick={onListPrices}>
              {t('prices.lists.useListAll')}
            </Button>
          </span>
        )}
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
        <Button size="sm" variant="tint-grey" onClick={onSettings}>
          <Settings2 size={14} aria-hidden="true" />
          {t('prices.lists.settings')}
        </Button>
        <Button size="sm" variant="tint-grey" onClick={onNewVersion}>
          <Upload size={14} aria-hidden="true" />
          {t('prices.lists.newVersion')}
        </Button>
        <Button size="sm" variant="tint-coral" onClick={onRemove} disabled={removing}>
          <Trash2 size={14} aria-hidden="true" />
          {t('prices.lists.drop.button')}
        </Button>
      </div>
    </div>
  )
}
