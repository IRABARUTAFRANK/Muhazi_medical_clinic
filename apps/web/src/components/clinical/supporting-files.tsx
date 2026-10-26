import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Lock,
  Paperclip,
  RotateCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Chip } from '@/components/ui/chip'
import { Field } from '@/components/ui/field'
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
  type OpenedFile,
  type PatientFileDoc,
} from '@/lib/api/files'
import { useConfirm } from '@/lib/confirm'
import { useNow } from '@/lib/hooks'
import { cn } from '@/lib/utils'

/**
 * Supporting files on the screens (migration 0089): photos, scans and PDF files attached to a
 * visit (and to a test of it by the laboratory / ultrasound). Three places use them:
 * - the patient file's "Files" tab (every visit the person may see, grouped by visit),
 * - the visit page ("Files of this visit"),
 * - the laboratory / ultrasound result entry ("Files of this test").
 * The database decides who sees, adds and removes (the privacy levels of 0088); these screens
 * only show what it returned. A file opens through a link that works 5 minutes.
 */

const when = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`
const errorBox = 'bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold'
const okBox = 'bg-green-bg text-green m-0 rounded-lg px-3 py-2 text-[13px] font-semibold'
const warnBox = 'bg-amber-bg text-amber m-0 rounded-lg px-3 py-2 text-[13px] font-semibold'
/** The id of the visit page's "Attachments of this visit" card (the test chips scroll to it). */
const VISIT_FILES_ID = 'visit-attachments'
const msgOf = (x: unknown) => (x instanceof Error ? x.message : String(x))

/** A card's message line: what was done, or a warning (a stored copy left behind). */
type Msg = { text: string; warn?: boolean }
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
      <CardHeader>
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
                <p className="text-ink-3 m-0 flex flex-wrap items-center gap-2 pb-1 text-[12px] font-semibold tracking-[.04em] uppercase">
                  {visitLabel(g.first, t)}
                  {g.first.visitOpen && (
                    <span className="bg-green-bg text-green rounded-full px-2 py-0.5 text-[11px] tracking-normal normal-case">
                      {t('supportingFiles.openVisit')}
                    </span>
                  )}
                </p>
                <FileRows files={g.files} patientName={patientName} onMessage={setMsg} showTest />
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
  if (!data || !data.available) return null
  if (data.files.length === 0 && data.hidden === 0 && !data.canAttach && !msg) return null
  const canAttach = data.canAttach && !closed

  return (
    <Card id={VISIT_FILES_ID}>
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          <Paperclip size={16} aria-hidden="true" />
          {t('supportingFiles.titleVisit')}
          {data.files.length > 0 && <Chip>{data.files.filter((f) => !f.removed).length}</Chip>}
        </span>
        {canAttach && !attaching && (
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
        {data.files.length > 0 ? (
          <FileRows files={data.files} patientName={patientName} onMessage={setMsg} showTest />
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
    <div className="border-border bg-card flex flex-col gap-2 rounded-xl border p-3">
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
          <FileRows files={data.files} patientName={patientName} onMessage={setMsg} />
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
    <p className="bg-violet/10 text-violet m-0 flex items-start gap-2 rounded-xl px-3 py-2 text-[13px] font-semibold">
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

/** The files, one row each: open (link of 5 minutes), remove with a reason within the rules. */
function FileRows({
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
  const { open, purge } = useFileActions()
  const [viewing, setViewing] = useState<OpenedFile | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [err, setErr] = useState<{ id: string; text: string } | null>(null)

  const show = async (f: PatientFileDoc) => {
    setErr(null)
    onMessage(null)
    try {
      setViewing(await open.mutateAsync(f.id))
    } catch (x) {
      setErr({ id: f.id, text: msgOf(x) })
    }
  }

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
      setErr({ id: f.id, text: msgOf(x) })
    }
  }

  return (
    <div className="border-border flex flex-col rounded-xl border">
      {files.map((f) => {
        const Icon = isImage(f.mimeType) ? ImageIcon : FileText
        return (
          <div
            key={f.id}
            className={cn(
              'border-grid flex flex-col gap-2 border-b px-3 py-2.5 last:border-b-0',
              f.removed && 'bg-hover/50',
            )}
          >
            <div className="flex flex-wrap items-center gap-3">
              <span
                className={cn(
                  'grid size-9 shrink-0 place-items-center rounded-lg',
                  f.removed ? 'bg-hover text-ink-3' : 'bg-primary-tint text-primary',
                )}
              >
                <Icon size={18} aria-hidden="true" />
              </span>
              <span className="min-w-[180px] flex-1">
                <span
                  className={cn(
                    'block font-semibold break-words',
                    f.removed && 'text-ink-3 line-through',
                  )}
                >
                  {f.title}
                </span>
                <span className="text-ink-3 block text-[12px]">
                  {[
                    t(`supportingFiles.kinds.${f.kind}`),
                    showTest && f.test ? t('supportingFiles.forTest', { test: f.test }) : null,
                    `${f.mimeType === 'application/pdf' ? 'PDF' : t('supportingFiles.image')} · ${formatFileSize(f.sizeBytes)}`,
                    t('supportingFiles.addedBy', {
                      name: f.uploadedBy ?? t('supportingFiles.someone'),
                      when: when(f.uploadedAt),
                    }),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {f.note && <span className="text-ink-2 block text-[13px]">{f.note}</span>}
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
                  <span className="text-amber block text-[12px] font-semibold">
                    {t('supportingFiles.storageLeftRow')}
                  </span>
                )}
              </span>
              {!f.visitOpen && f.view !== 'visit' && (
                <Chip title={t('supportingFiles.seenAs')}>
                  <Lock size={11} aria-hidden="true" className="mr-1" />
                  {t(`whoLooked.via.${f.view}`)}
                </Chip>
              )}
              {!f.removed && (
                <span className="flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    loading={open.isPending && open.variables === f.id}
                    onClick={() => void show(f)}
                  >
                    {!(open.isPending && open.variables === f.id) && (
                      <ExternalLink size={14} aria-hidden="true" />
                    )}
                    {t('supportingFiles.open')}
                  </Button>
                  {f.canRemove && removing !== f.id && (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        setErr(null)
                        onMessage(null)
                        setRemoving(f.id)
                      }}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                      {t('supportingFiles.remove')}
                    </Button>
                  )}
                </span>
              )}
              {/* only the manager lists removed files: a copy left behind is deleted here */}
              {f.removed && f.storageLeft && (
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
              )}
            </div>
            {removing === f.id && (
              <RemoveForm
                file={f}
                patientName={patientName}
                onDone={(m) => {
                  setRemoving(null)
                  onMessage(m)
                }}
                onCancel={() => setRemoving(null)}
              />
            )}
            {err?.id === f.id && (
              <p role="alert" className={errorBox}>
                {err.text}
              </p>
            )}
          </div>
        )
      })}
      {viewing && (
        <FileViewer file={viewing} onClose={() => setViewing(null)} onRenew={setViewing} />
      )}
    </div>
  )
}

/** Choose the type, the file and a title; checks type and size before sending; asks first. */
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
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [title, setTitle] = useState(test ?? '')
  const [note, setNote] = useState('')
  const [err, setErr] = useState<string | null>(null)

  // the picture chosen, shown small before sending (its link freed when it changes)
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview])

  const choose = (f: File | null) => {
    setErr(null)
    setFile(null)
    setPreview(null)
    if (!f) return
    const bad = checkFile(f)
    if (bad) {
      setErr(t(`stockErrors.${bad}`))
      if (input.current) input.current.value = ''
      return
    }
    setFile(f)
    if (isImage(f.type || '')) setPreview(URL.createObjectURL(f))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!file) {
      setErr(t('supportingFiles.chooseFirst'))
      return
    }
    if (!title.trim()) {
      setErr(t('stockErrors.titleNeeded'))
      return
    }
    setErr(null)
    if (
      !(await confirm({
        title: t('supportingFiles.confirm.attachTitle', { title: title.trim(), name: patientName }),
        body: test
          ? t('supportingFiles.confirm.attachBodyTest', { test })
          : t('supportingFiles.confirm.attachBody'),
        confirmLabel: t('supportingFiles.confirm.attachYes'),
      }))
    )
      return
    try {
      const done = await attach.mutateAsync({
        patientId,
        encounterId,
        file,
        kind,
        title: title.trim(),
        note: note.trim() || null,
        serviceRequestId,
      })
      onDone({ text: t('supportingFiles.attached', { title: done.title, name: patientName }) })
    } catch (x) {
      setErr(msgOf(x))
    }
  }

  const busy = attach.isPending
  return (
    <Reveal focus block="nearest">
      <form
        onSubmit={(e) => void submit(e)}
        className="border-border bg-hover/50 flex flex-col gap-3 rounded-xl border p-3"
      >
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0" disabled={busy}>
          <legend className="text-ink-2 mb-1.5 p-0 text-[13px] font-semibold">
            {t('supportingFiles.kind')}
          </legend>
          <span className="flex flex-wrap gap-1.5">
            {FILE_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
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
              'border-border bg-card hover:border-primary flex cursor-pointer flex-wrap items-center gap-3 rounded-xl border border-dashed px-3 py-3',
              busy && 'pointer-events-none opacity-60',
            )}
          >
            <input
              ref={input}
              type="file"
              accept={FILE_ACCEPT}
              className="sr-only"
              disabled={busy}
              onChange={(e) => choose(e.target.files?.[0] ?? null)}
            />
            {preview ? (
              <img
                src={preview}
                alt=""
                className="border-border size-14 shrink-0 rounded-lg border object-cover"
              />
            ) : (
              <span className="bg-primary-tint text-primary grid size-14 shrink-0 place-items-center rounded-lg">
                {file ? (
                  <FileText size={22} aria-hidden="true" />
                ) : (
                  <Upload size={22} aria-hidden="true" />
                )}
              </span>
            )}
            <span className="min-w-[160px] flex-1">
              <span className="block font-semibold [overflow-wrap:anywhere]">
                {file ? file.name : t('supportingFiles.choose')}
              </span>
              <span className="text-ink-3 block text-[12px]">
                {file
                  ? `${formatFileSize(file.size)} · ${t('supportingFiles.change')}`
                  : t('supportingFiles.chooseHint')}
              </span>
            </span>
          </label>
        </div>

        <Field
          label={t('supportingFiles.fileTitle')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('supportingFiles.fileTitlePh')}
          maxLength={160}
          disabled={busy}
          required
        />
        <Field
          label={t('supportingFiles.note')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('supportingFiles.notePh')}
          maxLength={500}
          disabled={busy}
        />

        {busy && file && (
          <div role="status" className="flex flex-col gap-1.5">
            <span className="text-ink-2 text-[13px] font-semibold">
              {t('supportingFiles.sending', { file: file.name })}
            </span>
            <span className="bg-border relative block h-1.5 overflow-hidden rounded-full">
              <span className="bg-primary absolute inset-y-0 left-0 w-1/3 animate-pulse rounded-full" />
            </span>
          </div>
        )}
        {err && (
          <p role="alert" className={errorBox}>
            {err}
          </p>
        )}
        <span className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={busy} disabled={!file}>
            {!busy && <Paperclip size={16} aria-hidden="true" />}
            {t('supportingFiles.send')}
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

/** Removing a file: the reason, then "Are you sure?" (the row stays, with who and why). */
function RemoveForm({
  file,
  patientName,
  onDone,
  onCancel,
}: {
  file: PatientFileDoc
  patientName: string
  onDone: (message: Msg) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { remove } = useFileActions()
  const [reason, setReason] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const why = reason.trim()
    if (why.length < 3) {
      setErr(t('stockErrors.reasonNeeded'))
      return
    }
    setErr(null)
    if (
      !(await confirm({
        title: t('supportingFiles.confirm.removeTitle', { title: file.title, name: patientName }),
        body: t('supportingFiles.confirm.removeBody', { reason: why }),
        confirmLabel: t('supportingFiles.confirm.removeYes'),
        tone: 'danger',
      }))
    )
      return
    try {
      const done = await remove.mutateAsync({ fileId: file.id, reason: why })
      // the row is removed; its copy in storage may not be (the manager finishes it)
      onDone(
        done.storageLeft
          ? { text: t('supportingFiles.storageLeft', { title: file.title }), warn: true }
          : { text: t('supportingFiles.removed', { title: file.title }) },
      )
    } catch (x) {
      setErr(msgOf(x))
    }
  }

  return (
    <Reveal focus block="nearest">
      <form
        onSubmit={(e) => void submit(e)}
        className="border-red/40 bg-red-bg/40 flex flex-col gap-2 rounded-xl border p-3"
      >
        <Field
          label={t('supportingFiles.removeReason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('supportingFiles.removeReasonPh')}
          maxLength={300}
          required
        />
        {err && (
          <p role="alert" className={errorBox}>
            {err}
          </p>
        )}
        <span className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" variant="danger" loading={remove.isPending}>
            {!remove.isPending && <Trash2 size={14} aria-hidden="true" />}
            {t('supportingFiles.removeSend')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t('supportingFiles.cancel')}
          </Button>
        </span>
      </form>
    </Reveal>
  )
}

/**
 * Can this browser show a PDF inside the page? Desktop browsers can; Android Chrome cannot (the
 * frame stays blank) and iOS Safari shows only the first page: phones and tablets open it in a
 * new tab instead.
 */
const pdfInline = () => {
  if (typeof window === 'undefined') return true
  const nav = navigator as Navigator & { pdfViewerEnabled?: boolean }
  if (nav.pdfViewerEnabled === false) return false
  return !window.matchMedia?.('(pointer: coarse)').matches
}

/**
 * The file opened: a picture in an <img>, a PDF in the browser's viewer (on a phone, a button
 * that opens it in a new tab), "Open in a new tab", and how long the link works. When the link
 * expires, what is on screen stays; "Open again" asks for a new link. Escape or Close shuts it.
 */
function FileViewer({
  file,
  onClose,
  onRenew,
}: {
  file: OpenedFile
  onClose: () => void
  /** A new link for the same file ("Open again"). */
  onRenew: (file: OpenedFile) => void
}) {
  const { t } = useTranslation()
  const { open } = useFileActions()
  const now = useNow(10_000)
  const close = useRef<HTMLButtonElement>(null)
  // the latest onClose, so that a new one (the list refreshed) does not move the focus again
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })
  const [renewErr, setRenewErr] = useState<string | null>(null)
  // sample mode gives data: links, which a new tab refuses: turned into a blob link
  const [blob, setBlob] = useState<string | null>(null)
  const isData = file.url.startsWith('data:')
  const src = isData ? (blob ?? file.url) : file.url
  const expired = now > new Date(file.expiresAt).getTime()
  const inline = isImage(file.mimeType) || pdfInline()

  useEffect(() => {
    if (!isData) return
    let live = true
    let made: string | null = null
    void fetch(file.url)
      .then((r) => r.blob())
      .then((b) => {
        if (!live) return
        made = URL.createObjectURL(b)
        setBlob(made)
      })
      .catch(() => undefined)
    return () => {
      live = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [file.url, isData])

  useEffect(() => {
    close.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const renew = async () => {
    setRenewErr(null)
    try {
      onRenew(await open.mutateAsync(file.id))
    } catch (x) {
      setRenewErr(msgOf(x))
    }
  }

  let body: ReactNode
  if (isImage(file.mimeType))
    body = (
      <img
        src={src}
        alt={file.title}
        className="mx-auto block max-h-[70vh] max-w-full object-contain"
      />
    )
  else if (inline)
    body = (
      <iframe
        src={src}
        title={file.title}
        className="border-border h-[70vh] w-full rounded-lg border bg-white"
      />
    )
  else
    body = (
      <div className="flex flex-col items-center gap-3 p-6 text-center">
        <FileText size={40} aria-hidden="true" className="text-primary" />
        {!expired && (
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-primary inline-flex min-h-12 items-center gap-2 rounded-xl px-5 text-[15px] font-bold text-white"
          >
            <ExternalLink size={18} aria-hidden="true" />
            {t('supportingFiles.openPdf')}
          </a>
        )}
        <p className="text-ink-2 m-0 text-[13px]">{t('supportingFiles.pdfPhone')}</p>
      </div>
    )

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={file.title}
        className="bg-card shadow-card flex max-h-[95vh] w-full max-w-4xl flex-col gap-3 rounded-[16px] p-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-[160px] flex-1 font-bold break-words">{file.title}</span>
          {!expired && inline && (
            <a
              href={src}
              target="_blank"
              rel="noopener noreferrer"
              className="border-border text-ink hover:bg-hover inline-flex min-h-10 items-center gap-2 rounded-xl border px-3 text-[13px] font-semibold"
            >
              <ExternalLink size={14} aria-hidden="true" />
              {t('supportingFiles.newTab')}
            </a>
          )}
          {expired && (
            <Button
              size="sm"
              variant="primary"
              loading={open.isPending}
              onClick={() => void renew()}
            >
              {!open.isPending && <RotateCw size={14} aria-hidden="true" />}
              {t('supportingFiles.openAgain')}
            </Button>
          )}
          <Button ref={close} size="sm" variant="ghost" onClick={onClose}>
            <X size={16} aria-hidden="true" />
            {t('supportingFiles.close')}
          </Button>
        </div>
        <div className="min-h-0 overflow-auto">{body}</div>
        {renewErr && (
          <p role="alert" className={errorBox}>
            {renewErr}
          </p>
        )}
        <p className={cn('m-0 text-[12px]', expired ? 'text-amber font-semibold' : 'text-ink-3')}>
          {t(expired ? 'supportingFiles.expired' : 'supportingFiles.linkNote')}
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- next to a test's result
/**
 * Next to a test on the visit page: "1 attachment" when the laboratory or ultrasound attached
 * an image or a printout to it. One file opens at once; several scroll to the visit's card.
 */
export function TestFilesChip({
  encounterId,
  patientId,
  serviceRequestId,
}: {
  encounterId: string
  patientId?: string | null
  serviceRequestId: string
}) {
  const { t } = useTranslation()
  // the same list as the visit's card (one request for every test of the visit)
  const { data } = useVisitFiles(encounterId, { patientId })
  const { open } = useFileActions()
  const [viewing, setViewing] = useState<OpenedFile | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const files = (data?.files ?? []).filter(
    (f) => f.serviceRequestId === serviceRequestId && !f.removed,
  )
  if (files.length === 0) return null

  const press = async () => {
    setErr(null)
    if (files.length > 1) {
      document
        .getElementById(VISIT_FILES_ID)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    try {
      setViewing(await open.mutateAsync(files[0]!.id))
    } catch (x) {
      setErr(msgOf(x))
    }
  }

  return (
    <span className="mt-1 flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => void press()}
        title={t('supportingFiles.countHint')}
        className="border-primary/40 bg-primary-tint text-primary hover:bg-primary/15 inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold"
      >
        <Paperclip size={12} aria-hidden="true" />
        {t('supportingFiles.count', { count: files.length })}
      </button>
      {err && (
        <span role="alert" className={errorBox}>
          {err}
        </span>
      )}
      {viewing && (
        <FileViewer file={viewing} onClose={() => setViewing(null)} onRenew={setViewing} />
      )}
    </span>
  )
}
