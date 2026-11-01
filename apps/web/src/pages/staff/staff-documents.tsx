import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  CalendarClock,
  FileText,
  FolderLock,
  Lock,
  Paperclip,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime } from '@mmc/shared'
import { Empty, Hint, ListRows, Panel, Pill } from '@/components/dash/kit'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Reveal } from '@/components/ui/reveal'
import { Select } from '@/components/ui/select'
import {
  FileThumb,
  FileViewer,
  RemoveForm,
  type Msg,
  type ViewerSource,
} from '@/components/clinical/file-viewer'
import { formatFileSize, isImage } from '@/lib/api/files'
import {
  EXPIRING_KINDS,
  STAFF_DOC_ACCEPT,
  STAFF_DOC_KINDS,
  checkStaffDoc,
  expiryTone,
  openStaffDocumentLink,
  useExpiringStaffDocuments,
  useStaffDocumentActions,
  useStaffDocuments,
  type StaffDocKind,
  type StaffDocument,
} from '@/lib/api/staff-documents'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'

/**
 * Employee document files (migration 0116): the licence, the contract signed, an identity
 * document, certificates, a CV and other crucial papers of one employee, kept in the clinic's
 * private storage. Two places use the panel:
 * - the Employees page (the manager): a "Documents" drawer per employee, where documents are
 *   added (several at once, each with its type, title, expiry date and note), opened in the
 *   file viewer and removed with a reason;
 * - "My documents" (every employee, from the user menu): their own, read only.
 * The database decides who sees, adds and removes; these screens only show what it returned.
 * The manager's dashboard gets the licences and contracts expiring within 60 days.
 */

const when = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`
/** An ISO date (YYYY-MM-DD) as the clinic writes dates, without a time-zone shift. */
const dayOf = (iso: string) => formatDate(new Date(`${iso}T00:00:00`))
const errorBox =
  'bg-red-bg text-red m-0 border border-red/30 rounded-md px-3 py-2 text-[13px] font-semibold'
const okBox =
  'bg-green-bg text-green m-0 border border-green/30 rounded-md px-3 py-2 text-[13px] font-semibold'
const warnBox =
  'bg-amber-bg text-amber m-0 border border-amber/30 rounded-md px-3 py-2 text-[13px] font-semibold'
const msgOf = (x: unknown) => (x instanceof Error ? x.message : String(x))
/** A title from a file name: "licence_ncnm_2026.pdf" → "licence ncnm 2026". */
const titleFromName = (name: string) =>
  name
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .slice(0, 160)

/** The expiry of a document: red when expired, amber within 60 days, plain after. */
export function ExpiryChip({
  d,
  className,
}: {
  d: Pick<StaffDocument, 'expiresOn' | 'daysLeft' | 'expired'>
  className?: string
}) {
  const { t } = useTranslation()
  const tone = expiryTone(d)
  if (!d.expiresOn || !tone) return null
  const days = d.daysLeft ?? 0
  const text =
    tone === 'expired'
      ? t('staffDocs.expiredOn', { date: dayOf(d.expiresOn) })
      : tone === 'soon'
        ? days === 0
          ? t('staffDocs.expiresToday')
          : t('staffDocs.expiresIn', { count: days })
        : t('staffDocs.expiresOn', { date: dayOf(d.expiresOn) })
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
        tone === 'expired' && 'bg-red-bg text-red',
        tone === 'soon' && 'bg-amber-bg text-amber',
        tone === 'ok' && 'bg-hover text-ink-2',
        className,
      )}
      title={tone === 'soon' ? t('staffDocs.expiresOn', { date: dayOf(d.expiresOn) }) : undefined}
    >
      <CalendarClock size={11} aria-hidden="true" />
      <span className="truncate">{text}</span>
    </span>
  )
}

function MsgLine({ msg }: { msg: Msg | null }) {
  if (!msg) return null
  return (
    <p role="status" className={msg.warn ? warnBox : okBox}>
      {msg.text}
    </p>
  )
}

// ---------------------------------------------------------------- the panel
/**
 * The documents of one employee: cards with the type, the title, the expiry, who added it and
 * when; "Add documents" (the manager), the viewer, "Remove" with a reason (the manager).
 * `readOnly` is the employee's own view ("My documents"): nothing is added or removed there.
 */
export function StaffDocumentsPanel({
  profileId,
  name,
  readOnly = false,
}: {
  profileId: string
  name: string
  readOnly?: boolean
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { data, isLoading, error } = useStaffDocuments(profileId)
  const { remove, purge } = useStaffDocumentActions()
  const [adding, setAdding] = useState(false)
  const [msg, setMsg] = useState<Msg | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [err, setErr] = useState<{ id: string; text: string } | null>(null)

  const canAct = !readOnly && !!data?.canAdd
  // the employee's own view never removes, whatever the rights say (the manager's own file)
  const docs = useMemo(
    () => (data?.documents ?? []).map((d) => (readOnly ? { ...d, canRemove: false } : d)),
    [data, readOnly],
  )
  const openable = docs.filter((d) => !d.removed)

  // how the viewer and the remove form reach the employee documents (not a patient's files)
  const source = useMemo<ViewerSource>(
    () => ({
      open: openStaffDocumentLink,
      remove: canAct
        ? async (f, reason) => {
            const done = await remove.mutateAsync({ documentId: f.id, reason })
            return done.storageLeft
              ? { text: t('staffDocs.storageLeft', { title: f.title }), warn: true }
              : { text: t('staffDocs.removed', { title: f.title }) }
          }
        : undefined,
      kindLabel: (f) => t(`staffDocs.kinds.${f.kind}`),
      confirmTitle: (f) => t('staffDocs.confirm.removeTitle', { title: f.title, name }),
      removeRule: t('staffDocs.removeRule'),
      reasonLabel: t('staffDocs.removeReason'),
      reasonPlaceholder: t('staffDocs.removeReasonPh'),
    }),
    [canAct, name, remove, t],
  )

  // the manager deletes the stored copy a removal left behind
  const finishRemoval = async (d: StaffDocument) => {
    setErr(null)
    setMsg(null)
    if (
      !(await confirm({
        title: t('staffDocs.confirm.purgeTitle', { title: d.title, name }),
        body: t('staffDocs.confirm.purgeBody'),
        confirmLabel: t('staffDocs.confirm.purgeYes'),
        tone: 'danger',
      }))
    )
      return
    try {
      await purge.mutateAsync(d)
      setMsg({ text: t('staffDocs.purged', { title: d.title }) })
    } catch (x) {
      setErr({ id: d.id, text: msgOf(x) })
    }
  }

  if (error)
    return (
      <p role="alert" className={errorBox}>
        {msgOf(error)}
      </p>
    )
  if (isLoading || !data) return <p className="text-ink-3 m-0">…</p>
  if (!data.available) return <p className={warnBox}>{t('staffDocs.unavailable')}</p>

  return (
    <div className="flex flex-col gap-3">
      <p className="text-ink-2 m-0 text-[14px]">
        {readOnly ? t('staffDocs.leadOwn') : t('staffDocs.lead', { name })}
      </p>
      {canAct && (
        <p className="text-ink-3 m-0 inline-flex items-center gap-1.5 text-[12px]">
          <Lock size={12} aria-hidden="true" />
          {t('staffDocs.recorded')}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="bg-blue-bg text-blue rounded-full px-2.5 py-0.5 text-[12px] font-semibold">
          {t('staffDocs.count', { count: openable.length })}
        </span>
        {data.removed > 0 && canAct && (
          <span className="text-ink-3 text-[12px]">
            {t('staffDocs.removedCount', { count: data.removed })}
          </span>
        )}
        {canAct && (
          <Button
            size="sm"
            variant="primary"
            className="ml-auto"
            aria-expanded={adding}
            onClick={() => {
              setMsg(null)
              setAdding((a) => !a)
            }}
          >
            {adding ? <X size={15} aria-hidden="true" /> : <Upload size={15} aria-hidden="true" />}
            {adding ? t('staffDocs.cancel') : t('staffDocs.add')}
          </Button>
        )}
      </div>
      <MsgLine msg={msg} />
      {adding && canAct && (
        <AddForm
          profileId={profileId}
          name={name}
          onDone={(m) => {
            setAdding(false)
            setMsg(m)
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {docs.length === 0 ? (
        <p className="text-ink-3 m-0 text-[14px]">
          {canAct ? t('staffDocs.emptyCanAdd') : t('staffDocs.empty')}
        </p>
      ) : (
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2.5 p-0 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] sm:gap-3">
          {docs.map((d) => (
            <li
              key={d.id}
              className={cn(
                'border-card-border bg-card shadow-card relative flex min-w-0 flex-col overflow-hidden rounded-[10px] border',
                d.removed
                  ? 'bg-hover/40'
                  : 'lift has-[button:focus-visible]:ring-primary has-[button:focus-visible]:ring-2',
              )}
            >
              <span className="border-card-border relative block aspect-[4/3] overflow-hidden border-b">
                <FileThumb file={d} recorded={!readOnly} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1 p-2.5">
                {d.removed ? (
                  <span
                    className="text-ink-3 block truncate text-[14px] font-semibold line-through"
                    title={d.title}
                  >
                    {d.title}
                  </span>
                ) : (
                  // the whole card opens the document (the button's area covers it)
                  <button
                    type="button"
                    onClick={() => {
                      setErr(null)
                      setMsg(null)
                      setRemovingId(null)
                      setViewing(d.id)
                    }}
                    title={d.title}
                    aria-label={t('staffDocs.openFile', { title: d.title })}
                    className="text-ink line-clamp-2 w-full text-left text-[14px] leading-snug font-semibold wrap-break-word outline-none after:absolute after:inset-0 after:content-['']"
                  >
                    {d.title}
                  </button>
                )}
                <span className="flex flex-wrap items-center gap-1">
                  <span className="bg-violet-bg text-violet max-w-full truncate rounded-full px-2 py-0.5 text-[11px] font-semibold">
                    {t(`staffDocs.kinds.${d.kind}`)}
                  </span>
                  <ExpiryChip d={d} />
                </span>
                {/* who added it, and when (the whole sentence on hover) */}
                <span
                  className="text-ink-3 flex flex-col text-[12px] leading-[1.35]"
                  title={t('staffDocs.addedBy', {
                    name: d.uploadedBy ?? t('staffDocs.someone'),
                    when: when(d.uploadedAt),
                  })}
                >
                  <span className="text-ink-2 truncate font-medium">
                    {d.uploadedBy ?? t('staffDocs.someone')}
                  </span>
                  <span className="tabular-nums">
                    {when(d.uploadedAt)} · {formatFileSize(d.sizeBytes)}
                  </span>
                </span>
                {d.note && !d.removed && (
                  <span className="text-ink-2 line-clamp-2 text-[12px]" title={d.note}>
                    {d.note}
                  </span>
                )}
                {d.removed && (
                  <span className="text-red block text-[12px] font-semibold">
                    {t('staffDocs.removedRow', {
                      name: d.removedBy ?? t('staffDocs.someone'),
                      when: d.removedAt ? when(d.removedAt) : '',
                      reason: d.removeReason ?? '',
                    })}
                  </span>
                )}
                {d.removed && d.storageLeft && canAct && (
                  <>
                    <span className="text-amber block text-[12px] font-semibold">
                      {t('staffDocs.storageLeftRow')}
                    </span>
                    <Button
                      size="sm"
                      variant="danger"
                      loading={purge.isPending && purge.variables?.id === d.id}
                      onClick={() => void finishRemoval(d)}
                    >
                      {!(purge.isPending && purge.variables?.id === d.id) && (
                        <Trash2 size={14} aria-hidden="true" />
                      )}
                      {t('staffDocs.purge')}
                    </Button>
                  </>
                )}
                {d.canRemove && removingId !== d.id && (
                  // above the card's opening area
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-red relative z-10 self-start"
                    aria-expanded={false}
                    onClick={() => {
                      setErr(null)
                      setMsg(null)
                      setRemovingId(d.id)
                    }}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    {t('staffDocs.remove')}
                  </Button>
                )}
                {removingId === d.id && (
                  <span className="relative z-10 block">
                    <RemoveForm
                      file={d}
                      patientName={name}
                      source={source}
                      onDone={(m) => {
                        setRemovingId(null)
                        setMsg(m)
                      }}
                      onCancel={() => setRemovingId(null)}
                    />
                  </span>
                )}
                {err?.id === d.id && (
                  <span role="alert" className={errorBox}>
                    {err.text}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {viewing && (
        <FileViewer
          files={openable}
          startId={viewing}
          patientName={name}
          source={source}
          onClose={() => setViewing(null)}
          onMessage={setMsg}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- adding
/** One file chosen, with its own type, title, expiry and note, and what happened to it. */
interface Chosen {
  key: string
  file: File
  kind: StaffDocKind
  title: string
  expiresOn: string
  note: string
  preview: string | null
  status: 'pending' | 'sending' | 'done' | 'failed'
  /** Why it was not added (checked before sending, or the server's refusal). */
  error: string | null
}

/**
 * Choose one or several files, a type (for all, changeable per file), a title per file (from the
 * file name), the expiry date of a licence or a contract and a note; checks type and size before
 * sending; asks once; sends them one after the other and says what happened to each. The ones
 * that failed stay listed with why, to correct and send again.
 */
function AddForm({
  profileId,
  name,
  onDone,
  onCancel,
}: {
  profileId: string
  name: string
  onDone: (message: Msg) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { add } = useStaffDocumentActions()
  const input = useRef<HTMLInputElement>(null)
  const [kind, setKind] = useState<StaffDocKind>('licence')
  const [rows, setRows] = useState<Chosen[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [sending, setSending] = useState<{ n: number; total: number; file: string } | null>(null)
  // "3 of 5 added": shown after a round with failures (the rest can be sent again)
  const [partial, setPartial] = useState<{ done: number; total: number } | null>(null)

  // the pictures chosen, shown small before sending (their links freed when the form goes)
  const previews = useRef<string[]>([])
  useEffect(() => {
    const list = previews.current
    return () => list.forEach((u) => URL.revokeObjectURL(u))
  }, [])

  const choose = (list: FileList | null) => {
    setErr(null)
    setPartial(null)
    if (!list || list.length === 0) return
    const added: Chosen[] = []
    for (const f of Array.from(list)) {
      const bad = checkStaffDoc(f)
      const preview = !bad && isImage(f.type || '') ? URL.createObjectURL(f) : null
      if (preview) previews.current.push(preview)
      added.push({
        key: `${f.name}|${f.size}|${f.lastModified}|${Math.random().toString(36).slice(2, 7)}`,
        file: f,
        kind,
        title: titleFromName(f.name),
        expiresOn: '',
        note: '',
        preview,
        status: bad ? 'failed' : 'pending',
        error: bad ? t(`stockErrors.${bad}`) : null,
      })
    }
    setRows((s) => [...s, ...added])
    if (input.current) input.current.value = ''
  }
  const dropRow = (key: string) => setRows((s) => s.filter((r) => r.key !== key))
  const setRow = (key: string, patch: Partial<Chosen>) =>
    setRows((s) => s.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  /** The type chosen for all: every file not sent yet takes it. */
  const chooseKind = (k: StaffDocKind) => {
    setKind(k)
    setRows((s) => s.map((r) => (r.status === 'done' ? r : { ...r, kind: k })))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const todo = rows.filter((r) => r.status !== 'done')
    if (todo.length === 0) {
      setErr(t('staffDocs.chooseFirst'))
      return
    }
    if (todo.some((r) => !r.title.trim())) {
      setErr(t('staffDocs.titlesNeeded'))
      return
    }
    setErr(null)
    setPartial(null)
    const one = todo.length === 1 ? todo[0]! : null
    if (
      !(await confirm({
        title: one
          ? t('staffDocs.confirm.addTitle', { title: one.title.trim(), name })
          : t('staffDocs.confirm.addManyTitle', { count: todo.length, name }),
        body: t('staffDocs.confirm.addBody', { name }),
        confirmLabel: t('staffDocs.confirm.addYes'),
      }))
    )
      return
    // one after the other: each row says what happened to it
    let done = 0
    let lastTitle = ''
    for (let i = 0; i < todo.length; i++) {
      const r = todo[i]!
      // a file refused before sending (type, size) is sent only once corrected: skip it
      const bad = checkStaffDoc(r.file)
      if (bad) {
        setRow(r.key, { status: 'failed', error: t(`stockErrors.${bad}`) })
        continue
      }
      setSending({ n: i + 1, total: todo.length, file: r.file.name })
      setRow(r.key, { status: 'sending', error: null })
      try {
        const saved = await add.mutateAsync({
          profileId,
          file: r.file,
          kind: r.kind,
          title: r.title.trim(),
          expiresOn: r.expiresOn || null,
          note: r.note.trim() || null,
        })
        setRow(r.key, { status: 'done', error: null })
        done++
        lastTitle = saved.title
      } catch (x) {
        setRow(r.key, { status: 'failed', error: msgOf(x) })
      }
    }
    setSending(null)
    const already = rows.length - todo.length
    if (done === todo.length) {
      const total = done + already
      onDone({
        text:
          total === 1
            ? t('staffDocs.added', { title: lastTitle, name })
            : t('staffDocs.addedMany', { count: total, name }),
      })
      return
    }
    setPartial({ done: done + already, total: rows.length })
  }

  const busy = sending !== null
  const pending = rows.filter((r) => r.status !== 'done')
  const statusClass: Record<Chosen['status'], string> = {
    pending: 'text-ink-3',
    sending: 'text-primary',
    done: 'text-green',
    failed: 'text-red',
  }
  return (
    <Reveal focus block="nearest">
      <form
        onSubmit={(e) => void submit(e)}
        className="border-border bg-hover/50 flex flex-col gap-3 rounded-md border p-3"
      >
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0" disabled={busy}>
          <legend className="text-ink-2 mb-1.5 p-0 text-[13px] font-semibold">
            {rows.length > 1 ? t('staffDocs.kindAll') : t('staffDocs.kind')}
          </legend>
          <span className="flex flex-wrap gap-1.5">
            {STAFF_DOC_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => chooseKind(k)}
                className={cn(
                  'min-h-9 rounded-full border px-3 text-[13px] font-semibold',
                  kind === k
                    ? 'border-primary bg-primary text-on-primary'
                    : 'border-border bg-card text-ink-2 hover:bg-hover',
                )}
              >
                {t(`staffDocs.kinds.${k}`)}
              </button>
            ))}
          </span>
        </fieldset>

        <div className="flex flex-col gap-1.5">
          <label
            className={cn(
              'border-border bg-card hover:border-primary flex cursor-pointer flex-wrap items-center gap-3 rounded-md border border-dashed px-3 py-3',
              busy && 'pointer-events-none opacity-60',
            )}
          >
            <input
              ref={input}
              type="file"
              accept={STAFF_DOC_ACCEPT}
              multiple
              className="sr-only"
              disabled={busy}
              onChange={(e) => choose(e.target.files)}
            />
            <span className="bg-primary-tint text-primary grid size-14 shrink-0 place-items-center rounded-md">
              <Upload size={22} aria-hidden="true" />
            </span>
            <span className="min-w-[160px] flex-1">
              <span className="block font-semibold [overflow-wrap:anywhere]">
                {rows.length === 0 ? t('staffDocs.chooseMany') : t('staffDocs.addMore')}
              </span>
              <span className="text-ink-3 block text-[12px]">{t('staffDocs.chooseHint')}</span>
            </span>
          </label>
        </div>

        {/* one block per file: thumbnail, title, type, expiry, note, what happened to it */}
        {rows.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-live="polite">
            {rows.map((r) => (
              <li
                key={r.key}
                className={cn(
                  'border-border bg-card grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-md border p-2.5',
                  r.status === 'done' && 'border-green/40 bg-green-bg/40',
                  r.status === 'failed' && 'border-red/40',
                )}
              >
                {r.preview ? (
                  <img
                    src={r.preview}
                    alt=""
                    className="border-border size-12 shrink-0 rounded-md border object-cover"
                  />
                ) : (
                  <span className="bg-primary-tint text-primary grid size-12 shrink-0 place-items-center rounded-md">
                    <FileText size={20} aria-hidden="true" />
                  </span>
                )}
                <span className="flex min-w-0 flex-col gap-1.5">
                  <span className="flex items-start justify-between gap-2">
                    <span
                      className="text-ink-3 block min-w-0 truncate text-[12px]"
                      title={r.file.name}
                    >
                      {r.file.name} · {formatFileSize(r.file.size)}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className={cn('text-[12px] font-semibold', statusClass[r.status])}>
                        {t(`staffDocs.status.${r.status}`)}
                      </span>
                      {r.status !== 'done' && !busy && (
                        <button
                          type="button"
                          onClick={() => dropRow(r.key)}
                          aria-label={t('staffDocs.rowRemove')}
                          title={t('staffDocs.rowRemove')}
                          className="text-ink-3 hover:bg-hover hover:text-ink inline-flex size-7 items-center justify-center rounded"
                        >
                          <X size={14} aria-hidden="true" />
                        </button>
                      )}
                    </span>
                  </span>
                  {r.status === 'done' ? (
                    <span className="block truncate font-semibold" title={r.title}>
                      {r.title} · {t(`staffDocs.kinds.${r.kind}`)}
                      {r.expiresOn &&
                        ` · ${t('staffDocs.expiresOn', { date: dayOf(r.expiresOn) })}`}
                    </span>
                  ) : (
                    <>
                      <Field
                        label={t('staffDocs.rowTitle')}
                        value={r.title}
                        onChange={(e) => setRow(r.key, { title: e.target.value })}
                        placeholder={t('staffDocs.fileTitlePh')}
                        maxLength={160}
                        disabled={busy}
                        required
                        className="h-9"
                      />
                      <span className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <Select
                          label={t('staffDocs.rowKind')}
                          value={r.kind}
                          onChange={(e) => setRow(r.key, { kind: e.target.value as StaffDocKind })}
                          disabled={busy}
                          className="h-9"
                        >
                          {STAFF_DOC_KINDS.map((k) => (
                            <option key={k} value={k}>
                              {t(`staffDocs.kinds.${k}`)}
                            </option>
                          ))}
                        </Select>
                        <Field
                          label={t('staffDocs.rowExpiry')}
                          type="date"
                          value={r.expiresOn}
                          onChange={(e) => setRow(r.key, { expiresOn: e.target.value })}
                          disabled={busy}
                          className="h-9"
                        />
                      </span>
                      {EXPIRING_KINDS.includes(r.kind) && !r.expiresOn && (
                        <span className="text-ink-3 block text-[12px]">
                          {t('staffDocs.expiryHint')}
                        </span>
                      )}
                      <Field
                        label={t('staffDocs.rowNote')}
                        value={r.note}
                        onChange={(e) => setRow(r.key, { note: e.target.value })}
                        placeholder={t('staffDocs.notePh')}
                        maxLength={500}
                        disabled={busy}
                        className="h-9"
                      />
                    </>
                  )}
                </span>
                {r.error && (
                  <span role="alert" className={cn(errorBox, 'col-span-full')}>
                    {r.error}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {sending && (
          <div role="status" className="flex flex-col gap-1.5">
            <span className="text-ink-2 text-[13px] font-semibold">
              {sending.total > 1
                ? t('staffDocs.sendingN', sending)
                : t('staffDocs.sending', { file: sending.file })}
            </span>
            <span className="bg-border relative block h-1.5 overflow-hidden rounded-full">
              <span
                className="bg-primary absolute inset-y-0 left-0 rounded-full transition-[width]"
                style={{
                  width: `${Math.max(12, Math.round(((sending.n - 1) / sending.total) * 100))}%`,
                }}
              />
            </span>
          </div>
        )}
        {partial && <p className={warnBox}>{t('staffDocs.partial', partial)}</p>}
        {err && (
          <p role="alert" className={errorBox}>
            {err}
          </p>
        )}
        <span className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={busy} disabled={pending.length === 0}>
            {!busy && <Paperclip size={16} aria-hidden="true" />}
            {partial
              ? t('staffDocs.sendAgain')
              : pending.length > 1
                ? t('staffDocs.sendMany', { count: pending.length })
                : t('staffDocs.send')}
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t('staffDocs.cancel')}
          </Button>
        </span>
        <p className="text-ink-3 m-0 text-[12px]">{t('staffDocs.removeRule')}</p>
      </form>
    </Reveal>
  )
}

// ---------------------------------------------------------------- the manager's dashboard
/** Licences and contracts expired or expiring within 60 days; each row opens the employee's documents. */
export function ExpiringDocumentsPanel({ i = 2 }: { i?: number }) {
  const { t } = useTranslation()
  const { data = [], error } = useExpiringStaffDocuments()
  return (
    <Panel
      i={i}
      icon={FolderLock}
      tint="navy"
      title={t('staffDocs.expiring.title')}
      right={`${t('staffDocs.expiring.days60')}: ${data.length}`}
      to="/app/staff"
    >
      {error && (
        <p role="alert" className={errorBox}>
          {msgOf(error)}
        </p>
      )}
      {!error && data.length === 0 && <Empty>{t('staffDocs.expiring.empty')}</Empty>}
      <ListRows
        rows={data.map((d) => ({
          key: d.id,
          pill: (
            <Pill tint={d.expired ? 'coral' : 'amber'} icon={CalendarClock}>
              {d.expired
                ? t('staffDocs.expiredShort')
                : d.daysLeft === 0
                  ? t('staffDocs.expiresToday')
                  : t('staffDocs.expiresIn', { count: d.daysLeft })}
            </Pill>
          ),
          label: t('staffDocs.expiring.row', {
            name: d.profileName,
            kind: t(`staffDocs.kinds.${d.kind}`),
          }),
          value: `${d.title} · ${dayOf(d.expiresOn)}`,
          to: `/app/staff?documents=${d.profileId}`,
        }))}
      />
      {data.length > 0 && <Hint>{t('staffDocs.expiring.hint')}</Hint>}
    </Panel>
  )
}
