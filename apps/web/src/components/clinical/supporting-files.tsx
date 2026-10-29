import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ChevronDown, ChevronUp, FileText, Lock, Paperclip, Trash2, Upload, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Chip } from '@/components/ui/chip'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { Reveal } from '@/components/ui/reveal'
import {
  FILE_ACCEPT,
  FILE_KINDS,
  checkFile,
  formatFileSize,
  isImage,
  useFileActions,
  usePatientFiles,
  useVisitFiles,
  type FileKind,
  type PatientFileDoc,
} from '@/lib/api/files'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import { FileThumb, FileViewer, type Msg } from './file-viewer'

/**
 * Supporting files on the screens (migration 0089): photos, scans and PDF files attached to a
 * visit (and to a test of it by the laboratory / ultrasound). Three places use them:
 * - the patient file's "Files" tab (every visit the person may see, grouped by visit),
 * - the visit page ("Files of this visit"),
 * - the laboratory / ultrasound result entry ("Files of this test").
 * The database decides who sees, adds and removes (the privacy levels of 0088); these screens
 * only show what it returned. The files are cards with a thumbnail; one opens in the full-screen
 * viewer (file-viewer.tsx) through a link that works 5 minutes; nothing opens inside the page.
 */

const when = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`
const errorBox =
  'bg-red-bg text-red m-0 border border-red/30 rounded-md px-3 py-2 text-[13px] font-semibold'
const okBox =
  'bg-green-bg text-green m-0 border border-green/30 rounded-md px-3 py-2 text-[13px] font-semibold'
const warnBox =
  'bg-amber-bg text-amber m-0 border border-amber/30 rounded-md px-3 py-2 text-[13px] font-semibold'
/** The id of the visit page's "Attachments of this visit" card. */
const VISIT_FILES_ID = 'visit-attachments'
const msgOf = (x: unknown) => (x instanceof Error ? x.message : String(x))
/** Whether the visit's documents are shown, kept while this tab stays on the visit. */
const openKey = (encounterId: string) => `mmc.visit-files-open:${encounterId}`
const readOpen = (encounterId: string): boolean => {
  try {
    return sessionStorage.getItem(openKey(encounterId)) === '1'
  } catch {
    return false
  }
}
const writeOpen = (encounterId: string, open: boolean) => {
  try {
    sessionStorage.setItem(openKey(encounterId), open ? '1' : '0')
  } catch {
    // private window or storage off: the choice lasts the page only
  }
}
/** A title from a file name: "echo_abdomen_2026.jpg" → "echo abdomen 2026". */
const titleFromName = (name: string) =>
  name
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .slice(0, 160)

/** A card's message line: what was done, or a warning (a stored copy left behind). */
function MsgLine({ msg }: { msg: Msg | null }) {
  if (!msg) return null
  return (
    <p role="status" className={msg.warn ? warnBox : okBox}>
      {msg.text}
    </p>
  )
}

// ---------------------------------------------------------------- the patient file
/**
 * The patient file's "Files" tab: the files of every visit the person may see, newest visit
 * first, a filter by type, "Attach a file" while the person may add to the open visit, and how
 * many files are in past visits that are private to them.
 */
export function PatientFilesSection({
  patientId,
  patientName,
  canRequest = false,
}: {
  patientId: string
  patientName: string
  /** The "Request access" button is shown at the top of the file (privacy notice). */
  canRequest?: boolean
}) {
  const { t } = useTranslation()
  const { data, isLoading, error } = usePatientFiles(patientId)
  const [kind, setKind] = useState<FileKind | 'all'>('all')
  const [attaching, setAttaching] = useState(false)
  const [msg, setMsg] = useState<Msg | null>(null)

  if (isLoading) return <p className="text-ink-3 m-0 text-[13px]">{t('supportingFiles.loading')}</p>
  if (error) return <p className={errorBox}>{msgOf(error)}</p>
  if (!data) return null

  const files = data.files
  const shown = files.filter((f) => kind === 'all' || f.kind === kind)
  const kinds = FILE_KINDS.filter((k) => files.some((f) => f.kind === k))
  // newest visit first (the files come newest first)
  const groups: { encounterId: string; first: PatientFileDoc; files: PatientFileDoc[] }[] = []
  for (const f of shown) {
    const g = groups.find((x) => x.encounterId === f.encounterId)
    if (g) g.files.push(f)
    else groups.push({ encounterId: f.encounterId, first: f, files: [f] })
  }
  groups.sort((a, b) => b.first.visitAt.localeCompare(a.first.visitAt))

  return (
    <Card>
      <CardHeader hue="violet">
        <span className="inline-flex items-center gap-2">
          <Paperclip size={16} aria-hidden="true" />
          {t('supportingFiles.title')}
          {files.length > 0 && <Chip>{files.filter((f) => !f.removed).length}</Chip>}
        </span>
        {data.attachTo && !attaching && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setMsg(null)
              setAttaching(true)
            }}
          >
            <Upload size={14} aria-hidden="true" />
            {t('supportingFiles.attach')}
          </Button>
        )}
      </CardHeader>
      <CardBody className="gap-3">
        {!data.available ? (
          <p className="text-ink-3 m-0 text-[13px]">{t('supportingFiles.unavailable')}</p>
        ) : (
          <>
            <p className="text-ink-2 m-0 text-[13px]">
              {t('supportingFiles.lead', { name: patientName })}{' '}
              {data.attachTo ? t('supportingFiles.leadAttach') : t('supportingFiles.leadNoAttach')}
            </p>

            {attaching && data.attachTo && (
              <AttachForm
                patientId={patientId}
                encounterId={data.attachTo}
                patientName={patientName}
                onDone={(m) => {
                  setAttaching(false)
                  setMsg(m)
                }}
                onCancel={() => setAttaching(false)}
              />
            )}
            <MsgLine msg={msg} />

            {kinds.length > 1 && (
              <div
                className="flex flex-wrap gap-1.5"
                role="group"
                aria-label={t('supportingFiles.kind')}
              >
                {(['all', ...kinds] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={kind === k}
                    onClick={() => setKind(k)}
                    className={cn(
                      'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold',
                      kind === k
                        ? 'border-primary bg-primary text-white'
                        : 'border-border bg-card text-ink-2 hover:bg-hover',
                    )}
                  >
                    {k === 'all' ? t('supportingFiles.all') : t(`supportingFiles.kinds.${k}`)}
                    <span
                      className={cn(
                        'rounded-full px-1.5 text-[12px]',
                        kind === k ? 'bg-white/20' : 'bg-hover',
                      )}
                    >
                      {k === 'all' ? files.length : files.filter((f) => f.kind === k).length}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* "No file yet" only when none is hidden either (else the lock line says it) */}
            {groups.length === 0 && data.hidden === 0 && (
              <p className="text-ink-3 m-0 text-[13px]">
                {t(data.attachTo ? 'supportingFiles.emptyCanAttach' : 'supportingFiles.empty')}
              </p>
            )}
            {groups.map((g) => (
              <div key={g.encounterId} className="flex flex-col">
                <p className="text-ink-3 m-0 flex flex-wrap items-center gap-2 pb-1 text-[12px] font-medium">
                  {visitLabel(g.first, t)}
                  {g.first.visitOpen && (
                    <span className="bg-green-bg text-green rounded px-2 py-0.5 text-[11px]">
                      {t('supportingFiles.openVisit')}
                    </span>
                  )}
                </p>
                <FileGrid files={g.files} patientName={patientName} onMessage={setMsg} showTest />
              </div>
            ))}

            <HiddenNote hidden={data.hidden} ask={canRequest} />
          </>
        )}
      </CardBody>
    </Card>
  )
}

// ---------------------------------------------------------------- the visit page
/**
 * The visit page's "Files of this visit": the list, and "Attach a file" for the people working
 * on the open visit. Nothing is shown before 0089, nor when there is nothing to show or to do.
 */
export function VisitFilesCard({
  encounterId,
  patientId,
  patientName,
  closed,
}: {
  encounterId: string
  patientId: string
  patientName: string
  closed: boolean
}) {
  const { t } = useTranslation()
  const { data } = useVisitFiles(encounterId, { patientId })
  const [attaching, setAttaching] = useState(false)
  const [msg, setMsg] = useState<Msg | null>(null)
  // the cards are behind "View documents (N)": closed when the visit opens, open while this tab
  // stays on the visit (session state)
  const [open, setOpen] = useState(() => readOpen(encounterId))
  if (!data || !data.available) return null
  if (data.files.length === 0 && data.hidden === 0 && !data.canAttach && !msg) return null
  const canAttach = data.canAttach && !closed
  const count = data.files.filter((f) => !f.removed).length
  const show = (v: boolean) => {
    setOpen(v)
    writeOpen(encounterId, v)
  }

  return (
    <Card id={VISIT_FILES_ID}>
      <CardHeader hue="violet">
        <span className="inline-flex items-center gap-2">
          <Paperclip size={16} aria-hidden="true" />
          {t('supportingFiles.titleVisit')}
          {data.files.length > 0 && <Chip>{count}</Chip>}
        </span>
        {/* "Attach a file" stays here while the documents are folded away */}
        {canAttach && !attaching && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setMsg(null)
              setAttaching(true)
              show(true)
            }}
          >
            <Upload size={14} aria-hidden="true" />
            {t('supportingFiles.attach')}
          </Button>
        )}
      </CardHeader>
      <CardBody className="gap-3">
        {attaching && canAttach && (
          <AttachForm
            patientId={data.patientId ?? patientId}
            encounterId={encounterId}
            patientName={patientName}
            onDone={(m) => {
              setAttaching(false)
              setMsg(m)
            }}
            onCancel={() => setAttaching(false)}
          />
        )}
        <MsgLine msg={msg} />
        <span>
          <Button
            size="sm"
            variant={open ? 'ghost' : 'tint-violet'}
            aria-expanded={open}
            aria-controls={`${VISIT_FILES_ID}-list`}
            onClick={() => show(!open)}
          >
            {open ? (
              <ChevronUp size={14} aria-hidden="true" />
            ) : (
              <ChevronDown size={14} aria-hidden="true" />
            )}
            {open
              ? t('supportingFiles.hideDocs')
              : count > 0
                ? t('supportingFiles.view', { count })
                : t('supportingFiles.viewNone')}
          </Button>
        </span>
        {open && (
          <div id={`${VISIT_FILES_ID}-list`} className="flex flex-col gap-3">
            {data.files.length > 0 ? (
              <FileGrid files={data.files} patientName={patientName} onMessage={setMsg} showTest />
            ) : (
              data.hidden === 0 && (
                <p className="text-ink-3 m-0 text-[13px]">
                  {t(canAttach ? 'supportingFiles.emptyCanAttach' : 'supportingFiles.empty')}
                </p>
              )
            )}
            {closed && data.files.length > 0 && (
              <p className="text-ink-3 m-0 text-[12px]">{t('supportingFiles.closedNote')}</p>
            )}
            <HiddenNote hidden={data.hidden} scope="visit" />
          </div>
        )}
      </CardBody>
    </Card>
  )
}

// ---------------------------------------------------------------- the result entry
/**
 * The files of one test, on the laboratory / ultrasound result entry: the list, and "Attach a
 * file" for the desk that does the test (the doctor who asked for it is told).
 */
export function TestFilesPanel({
  encounterId,
  patientId,
  patientName,
  serviceRequestId,
  test,
  imaging,
}: {
  encounterId: string
  patientId: string
  patientName: string
  serviceRequestId: string
  test: string
  /** An ultrasound (imaging) test: the files are ultrasound images by default. */
  imaging: boolean
}) {
  const { t } = useTranslation()
  const { data, isLoading } = useVisitFiles(encounterId, { patientId, serviceRequestId })
  const [attaching, setAttaching] = useState(false)
  const [msg, setMsg] = useState<Msg | null>(null)

  return (
    <div className="border-border bg-card flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink-2 inline-flex flex-1 items-center gap-1.5 text-[13px] font-semibold">
          <Paperclip size={14} aria-hidden="true" />
          {t('supportingFiles.titleTest', { test })}
        </span>
        {data?.canAttach && !attaching && (
          <Button
            size="sm"
            onClick={() => {
              setMsg(null)
              setAttaching(true)
            }}
          >
            <Upload size={14} aria-hidden="true" />
            {t('supportingFiles.attach')}
          </Button>
        )}
      </div>
      {isLoading && <p className="text-ink-3 m-0 text-[13px]">{t('supportingFiles.loading')}</p>}
      {data && !data.available && (
        <p className="text-ink-3 m-0 text-[13px]">{t('supportingFiles.unavailable')}</p>
      )}
      {attaching && data?.canAttach && (
        <AttachForm
          patientId={data.patientId ?? patientId}
          encounterId={encounterId}
          patientName={patientName}
          serviceRequestId={serviceRequestId}
          test={test}
          defaultKind={imaging ? 'ultrasound' : 'lab'}
          onDone={(m) => {
            setAttaching(false)
            setMsg(m)
          }}
          onCancel={() => setAttaching(false)}
        />
      )}
      <MsgLine msg={msg} />
      {data?.available &&
        (data.files.length > 0 ? (
          <FileGrid files={data.files} patientName={patientName} onMessage={setMsg} />
        ) : (
          data.hidden === 0 && (
            <p className="text-ink-3 m-0 text-[13px]">
              {t(data.canAttach ? 'supportingFiles.emptyTest' : 'supportingFiles.empty')}
            </p>
          )
        ))}
      {data && <HiddenNote hidden={data.hidden} scope="visit" />}
    </div>
  )
}

// ---------------------------------------------------------------- parts
type TFn = ReturnType<typeof useTranslation>['t']

const visitLabel = (f: PatientFileDoc, t: TFn) =>
  f.visitReference
    ? t('supportingFiles.visit', { ref: f.visitReference, date: formatDate(new Date(f.visitAt)) })
    : t('supportingFiles.visitNoRef', { date: formatDate(new Date(f.visitAt)) })

/**
 * How many files are private to the person: "N files belong to visits that are private to you"
 * on the patient file, "N files of this visit are private to you" for one visit or one test.
 */
function HiddenNote({
  hidden,
  ask = false,
  scope = 'patient',
}: {
  hidden: number
  ask?: boolean
  scope?: 'patient' | 'visit'
}) {
  const { t } = useTranslation()
  if (hidden <= 0) return null
  return (
    <p className="bg-violet-bg text-violet border-violet/30 m-0 flex items-start gap-2 rounded-md border px-3 py-2 text-[13px] font-semibold">
      <Lock size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>
        {t(scope === 'visit' ? 'supportingFiles.hiddenVisit' : 'supportingFiles.hidden', {
          count: hidden,
        })}
        {ask && ` ${t('supportingFiles.hiddenAsk')}`}
      </span>
    </p>
  )
}

/**
 * The files as cards (like a drive): a thumbnail, the title, the type, who added it and when,
 * the test. A card opens the file in the full-screen viewer (where it is downloaded, opened in a
 * new tab or removed); the files of the same list are its "next" and "previous".
 */
function FileGrid({
  files,
  patientName,
  onMessage,
  showTest = false,
}: {
  files: PatientFileDoc[]
  patientName: string
  /** The card's message line (the result of a removal), cleared when an action starts. */
  onMessage: (message: Msg | null) => void
  showTest?: boolean
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { purge } = useFileActions()
  const [viewing, setViewing] = useState<string | null>(null)
  const [err, setErr] = useState<{ id: string; text: string } | null>(null)
  const openable = files.filter((f) => !f.removed)

  // the manager deletes the stored copy a removal left behind
  const finishRemoval = async (f: PatientFileDoc) => {
    setErr(null)
    onMessage(null)
    if (
      !(await confirm({
        title: t('supportingFiles.confirm.purgeTitle', { title: f.title, name: patientName }),
        body: t('supportingFiles.confirm.purgeBody'),
        confirmLabel: t('supportingFiles.confirm.purgeYes'),
        tone: 'danger',
      }))
    )
      return
    try {
      await purge.mutateAsync(f)
      onMessage({ text: t('supportingFiles.purged', { title: f.title }) })
    } catch (x) {
      setErr({ id: f.id, text: x instanceof Error ? x.message : String(x) })
    }
  }

  return (
    <>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2.5 p-0 sm:grid-cols-[repeat(auto-fill,minmax(168px,1fr))] sm:gap-3">
        {files.map((f) => (
          <li
            key={f.id}
            className={cn(
              'border-card-border bg-card shadow-card relative flex min-w-0 flex-col overflow-hidden rounded-[10px] border',
              f.removed
                ? 'bg-hover/40'
                : 'lift has-[button:focus-visible]:ring-primary has-[button:focus-visible]:ring-2',
            )}
          >
            <span className="border-card-border relative block aspect-[4/3] overflow-hidden border-b">
              <FileThumb file={f} />
              {!f.visitOpen && f.view !== 'visit' && (
                <span
                  title={t('supportingFiles.seenAs')}
                  className="bg-card/95 text-violet absolute top-2 left-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold shadow-sm"
                >
                  <Lock size={11} aria-hidden="true" />
                  {t(`whoLooked.via.${f.view}`)}
                </span>
              )}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1 p-2.5">
              {f.removed ? (
                <span
                  className="text-ink-3 block truncate text-[14px] font-semibold line-through"
                  title={f.title}
                >
                  {f.title}
                </span>
              ) : (
                // the whole card opens the file (the button's area covers it)
                <button
                  type="button"
                  onClick={() => {
                    setErr(null)
                    onMessage(null)
                    setViewing(f.id)
                  }}
                  title={f.title}
                  aria-label={t('supportingFiles.viewer.openFile', { title: f.title })}
                  className="text-ink line-clamp-2 w-full text-left text-[14px] leading-snug font-semibold wrap-break-word outline-none after:absolute after:inset-0 after:content-['']"
                >
                  {f.title}
                </button>
              )}
              <span className="flex flex-wrap items-center gap-1">
                <span className="bg-violet-bg text-violet max-w-full truncate rounded-full px-2 py-0.5 text-[11px] font-semibold">
                  {t(`supportingFiles.kinds.${f.kind}`)}
                </span>
              </span>
              {showTest && f.test && (
                <span className="text-ink-2 block truncate text-[12px] font-medium" title={f.test}>
                  {t('supportingFiles.forTest', { test: f.test })}
                </span>
              )}
              {/* who added it, and when (the whole sentence on hover) */}
              <span
                className="text-ink-3 flex flex-col text-[12px] leading-[1.35]"
                title={t('supportingFiles.addedBy', {
                  name: f.uploadedBy ?? t('supportingFiles.someone'),
                  when: when(f.uploadedAt),
                })}
              >
                <span className="text-ink-2 truncate font-medium">
                  {f.uploadedBy ?? t('supportingFiles.someone')}
                </span>
                <span className="tabular-nums">{when(f.uploadedAt)}</span>
              </span>
              {f.removed && (
                <span className="text-red block text-[12px] font-semibold">
                  {t('supportingFiles.removedRow', {
                    name: f.removedBy ?? t('supportingFiles.someone'),
                    when: f.removedAt ? when(f.removedAt) : '',
                    reason: f.removeReason ?? '',
                  })}
                </span>
              )}
              {f.removed && f.storageLeft && (
                <>
                  <span className="text-amber block text-[12px] font-semibold">
                    {t('supportingFiles.storageLeftRow')}
                  </span>
                  {/* only the manager lists removed files: a copy left behind is deleted here */}
                  <Button
                    size="sm"
                    variant="danger"
                    loading={purge.isPending && purge.variables?.id === f.id}
                    onClick={() => void finishRemoval(f)}
                  >
                    {!(purge.isPending && purge.variables?.id === f.id) && (
                      <Trash2 size={14} aria-hidden="true" />
                    )}
                    {t('supportingFiles.purge')}
                  </Button>
                </>
              )}
              {err?.id === f.id && (
                <span role="alert" className={errorBox}>
                  {err.text}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {viewing && (
        <FileViewer
          files={openable}
          startId={viewing}
          patientName={patientName}
          onClose={() => setViewing(null)}
          onMessage={onMessage}
        />
      )}
    </>
  )
}

/** One file chosen, with its own type and title, and what happened to it. */
interface Chosen {
  key: string
  file: File
  kind: FileKind
  title: string
  preview: string | null
  status: 'pending' | 'sending' | 'done' | 'failed'
  /** Why it was not attached (checked before sending, or the server's refusal). */
  error: string | null
}

/**
 * Choose one or several files, a type (for all, changeable per file) and a title per file (from
 * the file name, or the test's name); checks type and size before sending; asks once; sends them
 * one after the other and says what happened to each. The ones that failed stay listed with why,
 * to correct and send again; the ones attached are kept as done.
 */
function AttachForm({
  patientId,
  encounterId,
  patientName,
  serviceRequestId = null,
  test = null,
  defaultKind = 'other',
  onDone,
  onCancel,
}: {
  patientId: string
  encounterId: string
  patientName: string
  serviceRequestId?: string | null
  test?: string | null
  defaultKind?: FileKind
  onDone: (message: Msg) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { attach } = useFileActions()
  const input = useRef<HTMLInputElement>(null)
  const [kind, setKind] = useState<FileKind>(defaultKind)
  const [rows, setRows] = useState<Chosen[]>([])
  const [note, setNote] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [sending, setSending] = useState<{ n: number; total: number; file: string } | null>(null)
  // "3 of 5 attached": shown after a round with failures (the rest can be sent again)
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
      const bad = checkFile(f)
      const preview = !bad && isImage(f.type || '') ? URL.createObjectURL(f) : null
      if (preview) previews.current.push(preview)
      added.push({
        key: `${f.name}|${f.size}|${f.lastModified}|${Math.random().toString(36).slice(2, 7)}`,
        file: f,
        kind,
        // one file for a test: the test's name; else the file's own name
        title: test && rows.length === 0 && list.length === 1 ? test : titleFromName(f.name),
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
  const chooseKind = (k: FileKind) => {
    setKind(k)
    setRows((s) => s.map((r) => (r.status === 'done' ? r : { ...r, kind: k })))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const todo = rows.filter((r) => r.status !== 'done')
    if (todo.length === 0) {
      setErr(t('supportingFiles.chooseFirst'))
      return
    }
    if (todo.some((r) => !r.title.trim())) {
      setErr(t('supportingFiles.titlesNeeded'))
      return
    }
    setErr(null)
    setPartial(null)
    const one = todo.length === 1 ? todo[0]! : null
    if (
      !(await confirm({
        title: one
          ? t('supportingFiles.confirm.attachTitle', { title: one.title.trim(), name: patientName })
          : t('supportingFiles.confirm.attachManyTitle', { count: todo.length, name: patientName }),
        body: test
          ? t('supportingFiles.confirm.attachBodyTest', { test })
          : t('supportingFiles.confirm.attachBody'),
        confirmLabel: t('supportingFiles.confirm.attachYes'),
      }))
    )
      return
    // one after the other: each row says what happened to it
    let done = 0
    let lastTitle = ''
    for (let i = 0; i < todo.length; i++) {
      const r = todo[i]!
      // a file refused before sending (type, size) is sent only once corrected: skip it
      const bad = checkFile(r.file)
      if (bad) {
        setRow(r.key, { status: 'failed', error: t(`stockErrors.${bad}`) })
        continue
      }
      setSending({ n: i + 1, total: todo.length, file: r.file.name })
      setRow(r.key, { status: 'sending', error: null })
      try {
        const saved = await attach.mutateAsync({
          patientId,
          encounterId,
          file: r.file,
          kind: r.kind,
          title: r.title.trim(),
          note: note.trim() || null,
          serviceRequestId,
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
            ? t('supportingFiles.attached', { title: lastTitle, name: patientName })
            : t('supportingFiles.attachedMany', { count: total, name: patientName }),
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
            {rows.length > 1 ? t('supportingFiles.kindAll') : t('supportingFiles.kind')}
          </legend>
          <span className="flex flex-wrap gap-1.5">
            {FILE_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => chooseKind(k)}
                className={cn(
                  'min-h-9 rounded-full border px-3 text-[13px] font-semibold',
                  kind === k
                    ? 'border-primary bg-primary text-white'
                    : 'border-border bg-card text-ink-2 hover:bg-hover',
                )}
              >
                {t(`supportingFiles.kinds.${k}`)}
              </button>
            ))}
          </span>
        </fieldset>

        <div className="flex flex-col gap-1.5">
          <span className="text-ink-2 text-[13px] font-semibold">{t('supportingFiles.file')}</span>
          <label
            className={cn(
              'border-border bg-card hover:border-primary flex cursor-pointer flex-wrap items-center gap-3 rounded-md border border-dashed px-3 py-3',
              busy && 'pointer-events-none opacity-60',
            )}
          >
            <input
              ref={input}
              type="file"
              accept={FILE_ACCEPT}
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
                {rows.length === 0 ? t('supportingFiles.chooseMany') : t('supportingFiles.addMore')}
              </span>
              <span className="text-ink-3 block text-[12px]">
                {t('supportingFiles.chooseHint')}
              </span>
            </span>
          </label>
        </div>

        {/* one line per file: thumbnail, title, type, what happened to it */}
        {rows.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-live="polite">
            {rows.map((r) => (
              <li
                key={r.key}
                className={cn(
                  'border-border bg-card grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-md border p-2.5 sm:grid-cols-[auto_minmax(0,2fr)_minmax(120px,1fr)_auto]',
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
                <span className="flex min-w-0 flex-col gap-1">
                  {r.status === 'done' ? (
                    <span className="block truncate font-semibold" title={r.title}>
                      {r.title}
                    </span>
                  ) : (
                    <Field
                      label={<span className="sr-only">{t('supportingFiles.rowTitle')}</span>}
                      value={r.title}
                      onChange={(e) => setRow(r.key, { title: e.target.value })}
                      placeholder={t('supportingFiles.fileTitlePh')}
                      maxLength={160}
                      disabled={busy}
                      required
                      className="h-9"
                    />
                  )}
                  <span className="text-ink-3 block truncate text-[12px]" title={r.file.name}>
                    {r.file.name} · {formatFileSize(r.file.size)}
                  </span>
                </span>
                {r.status === 'done' ? (
                  <span className="text-ink-2 self-center text-[13px]">
                    {t(`supportingFiles.kinds.${r.kind}`)}
                  </span>
                ) : (
                  <Select
                    label={<span className="sr-only">{t('supportingFiles.rowKind')}</span>}
                    value={r.kind}
                    onChange={(e) => setRow(r.key, { kind: e.target.value as FileKind })}
                    disabled={busy}
                    className="h-9"
                  >
                    {FILE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {t(`supportingFiles.kinds.${k}`)}
                      </option>
                    ))}
                  </Select>
                )}
                <span className="col-span-2 flex items-center justify-between gap-2 sm:col-span-1 sm:flex-col sm:items-end sm:justify-start">
                  <span className={cn('text-[12px] font-semibold', statusClass[r.status])}>
                    {t(`supportingFiles.status.${r.status}`)}
                  </span>
                  {r.status !== 'done' && !busy && (
                    <button
                      type="button"
                      onClick={() => dropRow(r.key)}
                      aria-label={t('supportingFiles.rowRemove')}
                      title={t('supportingFiles.rowRemove')}
                      className="text-ink-3 hover:bg-hover hover:text-ink inline-flex size-7 items-center justify-center rounded"
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
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

        <Field
          label={t('supportingFiles.note')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('supportingFiles.notePh')}
          maxLength={500}
          disabled={busy}
        />

        {sending && (
          <div role="status" className="flex flex-col gap-1.5">
            <span className="text-ink-2 text-[13px] font-semibold">
              {sending.total > 1
                ? t('supportingFiles.sendingN', sending)
                : t('supportingFiles.sending', { file: sending.file })}
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
        {partial && <p className={warnBox}>{t('supportingFiles.partial', partial)}</p>}
        {err && (
          <p role="alert" className={errorBox}>
            {err}
          </p>
        )}
        <span className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={busy} disabled={pending.length === 0}>
            {!busy && <Paperclip size={16} aria-hidden="true" />}
            {partial
              ? t('supportingFiles.sendAgain')
              : pending.length > 1
                ? t('supportingFiles.attachMany', { count: pending.length })
                : t('supportingFiles.send')}
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t('supportingFiles.cancel')}
          </Button>
        </span>
        <p className="text-ink-3 m-0 text-[12px]">{t('supportingFiles.removeRule')}</p>
      </form>
    </Reveal>
  )
}

// ---------------------------------------------------------------- next to a test's result
/**
 * Next to a test on the visit page: "1 attachment" when the laboratory or ultrasound attached
 * an image or a printout to it. It opens the test's files in the viewer (the first one shown).
 */
export function TestFilesChip({
  encounterId,
  patientId,
  serviceRequestId,
  patientName = '',
}: {
  encounterId: string
  patientId?: string | null
  serviceRequestId: string
  patientName?: string
}) {
  const { t } = useTranslation()
  // the same list as the visit's card (one request for every test of the visit)
  const { data } = useVisitFiles(encounterId, { patientId })
  const [viewing, setViewing] = useState<string | null>(null)
  const files = (data?.files ?? []).filter(
    (f) => f.serviceRequestId === serviceRequestId && !f.removed,
  )
  if (files.length === 0) return null

  return (
    <span className="mt-1 flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => setViewing(files[0]!.id)}
        title={t('supportingFiles.countHint')}
        className="border-primary/40 bg-primary-tint text-primary hover:bg-primary/15 inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold"
      >
        <Paperclip size={12} aria-hidden="true" />
        {t('supportingFiles.count', { count: files.length })}
      </button>
      {viewing && (
        <FileViewer
          files={files}
          startId={viewing}
          patientName={patientName}
          onClose={() => setViewing(null)}
        />
      )}
    </span>
  )
}
