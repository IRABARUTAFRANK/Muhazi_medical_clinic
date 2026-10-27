import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, apiError, isMissingFunction, sampleRefusal, type ApiErrorKind } from './errors'
import { sampleLabTests } from './lab'
import { sampleAccess, sampleVisitView, type VisitView } from './privacy'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'

/**
 * Supporting files on the patient file (migration 0089): photos, scans and PDFs (ultrasound
 * images, laboratory printouts, referral letters…) attached to a visit, and to a test of it when
 * the laboratory or ultrasound adds them.
 *
 * The files are in the PRIVATE Storage bucket `patient-files` at
 * `<patient id>/<visit id>/<file id>.<jpg|png|webp|pdf>`; the database keeps one row per file.
 * They follow the privacy levels (0088): a file of the open visit is seen by the people working
 * on it, a file of a past visit by the manager, the heads in charge, the clinician who treated
 * that visit and anyone with an approved request or emergency access. A file is opened through a
 * link valid 5 minutes (file_open checks and logs, then Storage signs the link, its own policy
 * checking again).
 *
 * Adding one: anyone working on the open visit who writes in the record, and the laboratory /
 * ultrasound desk on the visit's tests. Removing one: who added it within 24 hours, or the
 * manager, always with a reason.
 *
 * Older databases (before 0089) have none of these functions: the lists are empty and
 * `available` is false (the screens hide "Attach a file"). Sample mode keeps the files in memory.
 */

export type FileKind = 'ultrasound' | 'lab' | 'scan' | 'referral' | 'photo' | 'other'
export const FILE_KINDS: readonly FileKind[] = [
  'ultrasound',
  'lab',
  'scan',
  'referral',
  'photo',
  'other',
]
export type FileMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf'
export const FILE_TYPES: readonly FileMime[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]
/** 10 MB. */
export const FILE_MAX_BYTES = 10 * 1024 * 1024
/** For <input type="file" accept=…>. */
export const FILE_ACCEPT =
  '.jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf'
/** How long an opened link works. */
export const FILE_LINK_SECONDS = 300
export const FILES_BUCKET = 'patient-files'

/** One supporting file. */
export interface PatientFileDoc {
  id: string
  patientId: string
  encounterId: string
  visitReference: string | null
  visitOpen: boolean
  visitAt: string
  /** The test it belongs to (laboratory / ultrasound), and the test's name. */
  serviceRequestId: string | null
  test: string | null
  kind: FileKind
  title: string
  note: string | null
  mimeType: FileMime
  sizeBytes: number
  /** Storage path (not a link: open it with useOpenFile). */
  path: string
  uploadedById: string
  uploadedBy: string | null
  uploadedByRole: string | null
  uploadedAt: string
  /** Removed files are listed for the manager only. */
  removed: boolean
  removedAt: string | null
  removedBy: string | null
  removeReason: string | null
  /** A removed file whose copy is still in storage (the delete failed): the manager deletes it.
   *  Null where unknown. */
  storageLeft?: boolean | null
  /** Who added it within 24 hours, or the manager. */
  canRemove: boolean
  /** How the person sees the visit ('visit' = today's, 'own', 'head', 'manager'…). */
  view: VisitView
}

export interface FilesList {
  /** The files the person may see, newest first. */
  files: PatientFileDoc[]
  /** Files in visits the person may not see (show "N files are private"). */
  hidden: number
  /** Removed files among those the person may see (listed for the manager). */
  removed: number
  maxBytes: number
  types: FileMime[]
  /** False when the database is older than 0089 (no files at all). */
  available: boolean
}
export interface PatientFilesList extends FilesList {
  /** The open visit the person may add a file to (patient file: "Attach a file"), or null. */
  attachTo: string | null
}
export interface VisitFilesList extends FilesList {
  /** May the person add a file to this visit (to this test, when given). */
  canAttach: boolean
  encounterId: string
  patientId: string | null
}

export interface AttachFileInput {
  patientId: string
  encounterId: string
  file: File
  kind: FileKind
  title: string
  note?: string | null
  /** The test it belongs to (the result entry of the laboratory / ultrasound). */
  serviceRequestId?: string | null
}
export interface OpenedFile {
  id: string
  /** A link valid 5 minutes (sample mode: an object URL). */
  url: string
  mimeType: FileMime
  title: string
  expiresAt: string
}
export interface RemoveFileInput {
  fileId: string
  reason: string
}
export interface RemovedFile {
  id: string
  removedAt: string
  /** The row is removed but the copy in storage could not be deleted (the manager finishes it). */
  storageLeft: boolean
}

const KEY = ['files'] as const

// ---------------------------------------------------------------- checks before sending
/** The type a browser gives, made exact ('' or image/jpg from some phones). */
export function fileMime(file: Pick<File, 'type' | 'name'>): FileMime | null {
  const t = (file.type || '').toLowerCase()
  if (t === 'image/jpg' || t === 'image/pjpeg') return 'image/jpeg'
  if ((FILE_TYPES as readonly string[]).includes(t)) return t as FileMime
  if (t) return null
  const ext = file.name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'pdf') return 'application/pdf'
  return null
}
const EXT: Record<FileMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
}
/** Why the file cannot be sent (fileType, fileTooBig, fileEmpty), or null. */
export function checkFile(file: Pick<File, 'type' | 'name' | 'size'>): ApiErrorKind | null {
  if (!fileMime(file)) return 'fileType'
  if (file.size <= 0) return 'fileEmpty'
  if (file.size > FILE_MAX_BYTES) return 'fileTooBig'
  return null
}
/** "2.4 MB", "830 KB". */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}
export const isImage = (mime: string) => mime.startsWith('image/')

const uuid = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID()
  // http on the clinic network: no randomUUID outside secure contexts
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

type StorageErr = { message?: string; statusCode?: string | number } | null
/**
 * A Storage refusal in clinic words: sending ('send': row-level security, size and type limits of
 * the bucket) or opening ('open': the link refused, the file not there).
 */
const storageError = (e: StorageErr, ctx: 'send' | 'open'): ApiError => {
  const m = e?.message ?? ''
  const status = String(e?.statusCode ?? '')
  if (/bucket not found/i.test(m)) return sampleRefusal('filesUnavailable', 'P0002')
  const refused = /row-level security|unauthori[sz]ed|not allowed/i.test(m) || status === '403'
  if (ctx === 'open') {
    if (refused) return sampleRefusal('privateRecord', '42501')
    if (/not found/i.test(m) || status === '400' || status === '404')
      return sampleRefusal('notFound', 'P0002')
    return apiError({ message: m || 'The file could not be opened', code: status || null })
  }
  if (/maximum allowed size|too large/i.test(m) || status === '413')
    return sampleRefusal('fileTooBig', '22023')
  if (/mime type|not supported/i.test(m) || status === '415')
    return sampleRefusal('fileType', '22023')
  if (refused) return sampleRefusal('notOnVisit', '42501')
  return apiError({ message: m || 'The file could not be sent', code: status || null })
}
/**
 * Storage also refuses when the session needs the e-mailed code again or has gone idle (its rules
 * ask for an approved session, 0081): then that is said, not "you are not on this visit".
 */
const storageRefusal = async (e: ApiError): Promise<ApiError> => {
  if (!supabase || (e.kind !== 'notOnVisit' && e.kind !== 'privateRecord')) return e
  const st = await supabase.rpc('session_status')
  const ok = (st.data as { ok?: boolean } | null)?.ok
  return !st.error && ok === false ? sampleRefusal('sessionExpired', '42501') : e
}

// ---------------------------------------------------------------- sample data
const me = () => useSession.getState().user
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
/** The sample visits (as in the sample patient files; the sample visit page shows p-sample,: every patient's visit today is e-1). */
const sampleVisits = (patientId: string): { id: string; status: 'open' | 'closed' }[] => [
  { id: 'e-1', status: 'open' },
  { id: patientId === 'p-2' ? 'e-8' : 'e-9', status: 'closed' },
]
/** The past sample visits; every other sample visit (the worklist's) is in progress. */
const sampleStatus = (encounterId: string): 'open' | 'closed' =>
  encounterId === 'e-8' || encounterId === 'e-9' ? 'closed' : 'open'
const SAMPLE_REF: Record<string, string> = {
  'e-1': 'V-2026-000101',
  'e-8': 'V-2026-000097',
  'e-9': 'V-2026-000100',
}

/** Sample pictures (SVG): an ultrasound, a photo of a wound, a scanned page (portrait). */
const svgUrl = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
const sampleImage = (label = 'ABDOMEN', round = false) =>
  svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"><rect width="640" height="480" fill="#0b0b0b"/><path d="M320 40 L600 420 Q320 470 40 420 Z" fill="#262626"/><ellipse cx="320" cy="270" rx="${round ? 90 : 120}" ry="${round ? 90 : 80}" fill="#4a4a4a"/><ellipse cx="${round ? 330 : 320}" cy="${round ? 280 : 270}" rx="${round ? 46 : 70}" ry="${round ? 34 : 44}" fill="#131313"/><text x="24" y="36" fill="#bbb" font-family="monospace" font-size="16">MMC US · ${label} · SAMPLE</text></svg>`,
  )
const samplePhoto = () =>
  svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="#e9dccf"/><ellipse cx="400" cy="320" rx="330" ry="210" fill="#b98463"/><ellipse cx="410" cy="310" rx="120" ry="46" fill="#c9574f"/><ellipse cx="410" cy="310" rx="80" ry="22" fill="#8e2f2b"/><rect x="40" y="520" width="200" height="40" rx="6" fill="#fff"/><text x="56" y="547" fill="#333" font-family="sans-serif" font-size="20">0 · 1 · 2 · 3 cm</text><text x="560" y="560" fill="#5b4636" font-family="sans-serif" font-size="18">SAMPLE PHOTO</text></svg>`,
  )
const sampleScan = () =>
  svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800"><rect width="600" height="800" fill="#f7f5ef"/><text x="50" y="80" fill="#1f2937" font-family="serif" font-size="26">Kiziguro Health Centre</text><text x="50" y="116" fill="#4b5563" font-family="serif" font-size="18">Prescription · 14/08/2026 · SAMPLE</text>${[
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]
      .map(
        (i) =>
          `<rect x="50" y="${170 + i * 48}" width="${300 + ((i * 37) % 200)}" height="10" rx="5" fill="#9ca3af"/>`,
      )
      .join(
        '',
      )}<path d="M380 700 q40 -50 80 0 t80 0" stroke="#1d4ed8" stroke-width="4" fill="none"/></svg>`,
  )
/** A one-page PDF with a few lines (valid enough for the browser's viewer). */
const samplePdf = (lines: string[]) => {
  const text = lines
    .map((l, i) => `BT /F1 14 Tf 60 ${760 - i * 24} Td (${l.replace(/[()\\]/g, '')}) Tj ET`)
    .join('\n')
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return `data:application/pdf;base64,${btoa(out)}`
}

interface SampleFile extends Omit<PatientFileDoc, 'canRemove' | 'view'> {
  url: string
}
let sampleFiles: SampleFile[] | null = null
const sampleStore = (): SampleFile[] => {
  if (sampleFiles) return sampleFiles
  const base = {
    patientId: 'p-2',
    note: null,
    removed: false,
    removedAt: null,
    removedBy: null,
    removeReason: null,
  }
  // fd-4 to fd-7 are of Mukamana Alice (p-sample), the patient of the sample visit page
  sampleFiles = [
    {
      ...base,
      id: 'fd-1',
      encounterId: 'e-1',
      visitReference: SAMPLE_REF['e-1']!,
      visitOpen: true,
      visitAt: minutesAgo(90),
      serviceRequestId: 'sr-us-1',
      test: 'Abdominal ultrasound',
      kind: 'ultrasound',
      title: 'Abdominal ultrasound: liver and kidneys',
      mimeType: 'image/png',
      sizeBytes: 812_000,
      path: 'p-2/e-1/fd-1.png',
      uploadedById: 'u-sono',
      uploadedBy: 'Uwase Claudine',
      uploadedByRole: 'sonographer',
      uploadedAt: minutesAgo(25),
      url: sampleImage(),
    },
    {
      ...base,
      id: 'fd-3',
      encounterId: 'e-1',
      visitReference: SAMPLE_REF['e-1']!,
      visitOpen: true,
      visitAt: minutesAgo(90),
      serviceRequestId: 'sr-us-1',
      test: 'Abdominal ultrasound',
      kind: 'ultrasound',
      title: 'Abdominal ultrasound: gallbladder',
      mimeType: 'image/png',
      sizeBytes: 640_000,
      path: 'p-2/e-1/fd-3.png',
      uploadedById: 'u-sono',
      uploadedBy: 'Uwase Claudine',
      uploadedByRole: 'sonographer',
      uploadedAt: minutesAgo(24),
      url: sampleImage('GALLBLADDER', true),
    },
    {
      ...base,
      id: 'fd-4',
      patientId: 'p-sample',
      encounterId: 'e-1',
      visitReference: SAMPLE_REF['e-1']!,
      visitOpen: true,
      visitAt: minutesAgo(90),
      serviceRequestId: null,
      test: null,
      kind: 'photo',
      title: 'Wound on the left forearm',
      note: 'Taken before cleaning, with the ruler',
      mimeType: 'image/jpeg',
      sizeBytes: 1_450_000,
      path: 'p-sample/e-1/fd-4.jpg',
      uploadedById: 'u-doc',
      uploadedBy: 'Dr. Mukamana Béatrice',
      uploadedByRole: 'doctor',
      uploadedAt: minutesAgo(50),
      url: samplePhoto(),
    },
    {
      ...base,
      id: 'fd-5',
      patientId: 'p-sample',
      encounterId: 'e-1',
      visitReference: SAMPLE_REF['e-1']!,
      visitOpen: true,
      visitAt: minutesAgo(90),
      serviceRequestId: null,
      test: null,
      kind: 'lab',
      title: 'Full blood count from Kiziguro',
      mimeType: 'application/pdf',
      sizeBytes: 98_000,
      path: 'p-sample/e-1/fd-5.pdf',
      uploadedById: 'u-nur',
      uploadedBy: 'Nyirahabimana Chantal',
      uploadedByRole: 'nurse',
      uploadedAt: minutesAgo(70),
      url: samplePdf([
        'Kiziguro Health Centre - Laboratory',
        'Full blood count (sample)',
        'Haemoglobin 11.8 g/dL',
        'White cells 9.4 x10^9/L',
        'Platelets 260 x10^9/L',
      ]),
    },
    {
      ...base,
      id: 'fd-6',
      patientId: 'p-sample',
      encounterId: 'e-1',
      visitReference: SAMPLE_REF['e-1']!,
      visitOpen: true,
      visitAt: minutesAgo(90),
      serviceRequestId: null,
      test: null,
      kind: 'scan',
      title: 'Previous prescription from the health centre',
      mimeType: 'image/png',
      sizeBytes: 520_000,
      path: 'p-sample/e-1/fd-6.png',
      uploadedById: 'u-nur',
      uploadedBy: 'Nyirahabimana Chantal',
      uploadedByRole: 'nurse',
      uploadedAt: minutesAgo(80),
      url: sampleScan(),
    },
    {
      ...base,
      id: 'fd-7',
      patientId: 'p-sample',
      encounterId: 'e-1',
      visitReference: SAMPLE_REF['e-1']!,
      visitOpen: true,
      visitAt: minutesAgo(90),
      serviceRequestId: null,
      test: null,
      kind: 'ultrasound',
      title: 'Pelvic ultrasound from the district hospital',
      mimeType: 'image/png',
      sizeBytes: 702_000,
      path: 'p-sample/e-1/fd-7.png',
      uploadedById: 'u-doc',
      uploadedBy: 'Dr. Mukamana Béatrice',
      uploadedByRole: 'doctor',
      uploadedAt: minutesAgo(35),
      url: sampleImage('PELVIS', true),
    },
    {
      ...base,
      id: 'fd-2',
      encounterId: 'e-8',
      visitReference: SAMPLE_REF['e-8']!,
      visitOpen: false,
      visitAt: '2026-08-20T08:40:00Z',
      serviceRequestId: null,
      test: null,
      kind: 'referral',
      title: 'Referral letter from Kiziguro health centre',
      note: 'Ear pain, not better after 5 days of amoxicillin',
      mimeType: 'application/pdf',
      sizeBytes: 146_000,
      path: 'p-2/e-8/fd-2.pdf',
      uploadedById: 'u-doc2',
      uploadedBy: 'Dr. Habineza Jean',
      uploadedByRole: 'doctor',
      uploadedAt: '2026-08-20T09:05:00Z',
      url: samplePdf([
        'Kiziguro Health Centre - Referral',
        'Patient: Habimana Eric (8 years)',
        'Reason: ear pain for 5 days, fever 38.4',
        'Treatment given: amoxicillin 250 mg x3/day',
        'Referred to: Muhazi Medical Clinic (ENT review)',
      ]),
    },
  ]
  return sampleFiles
}
/** The row the screens get (the sample link stays in memory). */
const withoutUrl = (f: SampleFile): Omit<SampleFile, 'url'> => {
  const c: Partial<SampleFile> = { ...f }
  delete c.url
  return c as Omit<SampleFile, 'url'>
}
const sampleManager = () => {
  const u = me()
  return !u || u.role === 'manager'
}
/** A sample test of the visit is at the signed-in laboratory / ultrasound person's bench. */
const sampleAtMyBench = (encounterId: string, serviceRequestId?: string | null) => {
  const u = me()
  if (u?.role !== 'lab_tech') return false
  const imaging = u.dbRole === 'sonographer'
  return sampleLabTests().some(
    (o) =>
      o.encounterId === encounterId &&
      (o.category === 'imaging') === imaging &&
      (!serviceRequestId || o.id === serviceRequestId),
  )
}
/** How the sample person sees a sample visit's files (null = private). */
const sampleView = (patientId: string, encounterId: string): VisitView | null => {
  const u = me()
  if (u && (u.role === 'receptionist' || u.role === 'cashier')) return null
  const status = sampleStatus(encounterId)
  // the laboratory / ultrasound: the visits in progress with a test at their bench
  if (u?.role === 'lab_tech')
    return status === 'open' && sampleAtMyBench(encounterId) ? 'visit' : null
  const access = sampleAccess(patientId, sampleVisits(patientId))
  return sampleVisitView(access, { id: encounterId, status })
}
/** One sample file: its visit's view, or the person who added it for 24 hours ('own'). */
const sampleFileView = (f: SampleFile): VisitView | null => {
  const view = sampleView(f.patientId, f.encounterId)
  if (view) return view
  const u = me()
  return !f.removed &&
    f.uploadedById === u?.id &&
    Date.now() - new Date(f.uploadedAt).getTime() < 24 * 3600_000
    ? 'own'
    : null
}
const sampleCanAttach = (
  patientId: string,
  encounterId: string,
  serviceRequestId?: string | null,
) => {
  if (sampleStatus(encounterId) !== 'open') return false
  if (me()?.role === 'lab_tech') return sampleAtMyBench(encounterId, serviceRequestId)
  return sampleView(patientId, encounterId) === 'visit'
}
const sampleList = (
  patientId: string,
  encounterId?: string | null,
  serviceRequestId?: string | null,
): FilesList => {
  const manager = sampleManager()
  const u = me()
  const rows = sampleStore().filter(
    (f) =>
      f.patientId === patientId &&
      (!encounterId || f.encounterId === encounterId) &&
      (!serviceRequestId || f.serviceRequestId === serviceRequestId),
  )
  const files: PatientFileDoc[] = []
  let hidden = 0
  let removed = 0
  for (const f of rows) {
    const view = sampleFileView(f)
    if (!view) {
      if (!f.removed) hidden++
      continue
    }
    if (f.removed) {
      removed++
      if (!manager) continue
    }
    files.push({
      ...withoutUrl(f),
      storageLeft: f.removed ? false : null,
      view,
      canRemove:
        !f.removed &&
        (manager ||
          (f.uploadedById === u?.id &&
            Date.now() - new Date(f.uploadedAt).getTime() < 24 * 3600_000)),
    })
  }
  files.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
  return {
    files,
    hidden,
    removed,
    maxBytes: FILE_MAX_BYTES,
    types: [...FILE_TYPES],
    available: true,
  }
}

const EMPTY: FilesList = {
  files: [],
  hidden: 0,
  removed: 0,
  maxBytes: FILE_MAX_BYTES,
  types: [...FILE_TYPES],
  available: false,
}

// ---------------------------------------------------------------- reading
/** The patient file's "Files": every visit's the person may see, and the open visit to add to. */
export function usePatientFiles(patientId: string, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'patient', patientId],
    enabled: enabled && !!patientId,
    refetchInterval: 60_000,
    queryFn: async (): Promise<PatientFilesList> => {
      if (!supabase) {
        const open = sampleVisits(patientId).find((v) => v.status === 'open')
        return {
          ...sampleList(patientId),
          attachTo: open && sampleCanAttach(patientId, open.id) ? open.id : null,
        }
      }
      const { data, error } = await supabase.rpc('list_patient_files', {
        p_patient_id: patientId,
      })
      if (error) {
        if (isMissingFunction(error)) return { ...EMPTY, attachTo: null }
        throw apiError(error)
      }
      return { ...(data as Omit<PatientFilesList, 'available'>), available: true }
    },
  })
}

/** One visit's files (the visit page), or one test's (the result entry); may the person add one. */
export function useVisitFiles(
  encounterId: string,
  o: { patientId?: string | null; serviceRequestId?: string | null; enabled?: boolean } = {},
) {
  const serviceRequestId = o.serviceRequestId ?? null
  return useQuery({
    queryKey: [...KEY, 'visit', encounterId, serviceRequestId, o.patientId ?? null],
    enabled: (o.enabled ?? true) && !!encounterId,
    refetchInterval: 60_000,
    queryFn: async (): Promise<VisitFilesList> => {
      if (!supabase) {
        // the patient the screen shows (the sample visits do not all agree on who is in e-1)
        const pid =
          o.patientId ??
          sampleStore().find((f) => f.encounterId === encounterId)?.patientId ??
          'p-sample'
        return {
          ...sampleList(pid, encounterId, serviceRequestId),
          canAttach: sampleCanAttach(pid, encounterId, serviceRequestId),
          encounterId,
          patientId: pid,
        }
      }
      const { data, error } = await supabase.rpc('list_visit_files', {
        p_encounter_id: encounterId,
        p_service_request_id: serviceRequestId,
      })
      if (error) {
        if (isMissingFunction(error))
          return { ...EMPTY, canAttach: false, encounterId, patientId: o.patientId ?? null }
        throw apiError(error)
      }
      return { ...(data as Omit<VisitFilesList, 'available'>), available: true }
    },
  })
}

// ---------------------------------------------------------------- the 5-minute link
/**
 * A link to one file, valid 5 minutes: file_open checks (and logs the opening of a past visit's
 * file), then Storage signs the link. Sample mode gives the file kept in memory.
 */
export async function openFileLink(fileId: string): Promise<OpenedFile> {
  const expiresAt = new Date(Date.now() + FILE_LINK_SECONDS * 1000).toISOString()
  if (!supabase) {
    const f = sampleStore().find((x) => x.id === fileId)
    if (!f || (f.removed && !sampleManager())) throw sampleRefusal('notFound', 'P0002')
    if (f.removed) throw sampleRefusal('alreadyRemoved', '22023')
    if (!sampleFileView(f)) throw sampleRefusal('privateRecord', '42501')
    return { id: f.id, url: f.url, mimeType: f.mimeType, title: f.title, expiresAt }
  }
  const { data, error } = await supabase.rpc('file_open', { p_file_id: fileId })
  if (error) {
    if (isMissingFunction(error)) throw sampleRefusal('filesUnavailable', 'PGRST202')
    throw apiError(error)
  }
  const o = data as { path: string; mimeType: FileMime; title: string; expiresIn?: number }
  const signed = await supabase.storage
    .from(FILES_BUCKET)
    .createSignedUrl(o.path, o.expiresIn ?? FILE_LINK_SECONDS)
  if (signed.error || !signed.data?.signedUrl)
    throw await storageRefusal(storageError(signed.error as StorageErr, 'open'))
  return { id: fileId, url: signed.data.signedUrl, mimeType: o.mimeType, title: o.title, expiresAt }
}

/** A link is asked again 30 seconds before it stops working. */
const LINK_FRESH_MS = (FILE_LINK_SECONDS - 30) * 1000
/** The cache of opened links (outside ['files'], so a list refresh does not open them again). */
export const fileLinkKey = (fileId: string) => ['file-link', fileId] as const
/** Is this link still good for a while? */
export const linkFresh = (f: OpenedFile | null | undefined, now = Date.now()) =>
  !!f && new Date(f.expiresAt).getTime() - now > 30_000

/**
 * The link of one file, shared by the viewer and the thumbnails (one request per file per 5
 * minutes). Only enable it where opening is not a recorded look (a file of today's visit: the
 * thumbnails), or when the person opened the file (the viewer).
 */
export function useFileLink(fileId: string | null, enabled = true) {
  const qc = useQueryClient()
  return useQuery({
    queryKey: fileLinkKey(fileId ?? ''),
    enabled: enabled && !!fileId,
    queryFn: async () => {
      const o = await openFileLink(fileId!)
      // opening a past visit's file is logged
      void qc.invalidateQueries({ queryKey: ['privacy'] })
      return o
    },
    staleTime: LINK_FRESH_MS,
    gcTime: FILE_LINK_SECONDS * 1000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
}

// ---------------------------------------------------------------- acting
/**
 * attach: checks the type and size, sends the file to Storage, then registers it (attach_file);
 * if registering is refused, the file just sent is deleted again.
 * open: a link valid 5 minutes (window.open it, or show it in an <img> / <iframe>).
 * remove: soft removal with a reason (who added it within 24 hours, or the manager), then the
 * file is deleted from Storage.
 * Refusals come as ApiError with kind fileType, fileTooBig, fileEmpty, filePath, titleNeeded,
 * fileKind, notOnVisit, visitClosed, wrongTest, notUploaded, privateRecord, reasonNeeded,
 * notUploader, removeTooLate, alreadyRemoved, notFound or filesUnavailable.
 */
export function useFileActions() {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: KEY })
    void qc.invalidateQueries({ queryKey: ['notifications'] })
  }

  const attach = useMutation({
    mutationFn: async (i: AttachFileInput): Promise<PatientFileDoc> => {
      const bad = checkFile(i.file)
      if (bad) throw sampleRefusal(bad, '22023')
      if (!i.title.trim()) throw sampleRefusal('titleNeeded', '22023')
      const mime = fileMime(i.file)!
      const id = uuid()
      const path = `${i.patientId}/${i.encounterId}/${id}.${EXT[mime]}`
      if (!supabase) {
        if (!sampleCanAttach(i.patientId, i.encounterId, i.serviceRequestId))
          throw sampleRefusal('notOnVisit', '42501')
        const u = me()
        const row: SampleFile = {
          id,
          patientId: i.patientId,
          encounterId: i.encounterId,
          visitReference: SAMPLE_REF[i.encounterId] ?? null,
          visitOpen: true,
          visitAt: minutesAgo(60),
          serviceRequestId: i.serviceRequestId ?? null,
          test: sampleLabTests().find((o) => o.id === i.serviceRequestId)?.test ?? null,
          kind: i.kind,
          title: i.title.trim(),
          note: i.note?.trim() || null,
          mimeType: mime,
          sizeBytes: i.file.size,
          path,
          uploadedById: u?.id ?? 'u-doc',
          uploadedBy: u?.name ?? null,
          uploadedByRole: u?.role ?? null,
          uploadedAt: new Date().toISOString(),
          removed: false,
          removedAt: null,
          removedBy: null,
          removeReason: null,
          url: URL.createObjectURL(i.file),
        }
        sampleFiles = [row, ...sampleStore()]
        return { ...withoutUrl(row), view: 'visit', canRemove: true }
      }
      const up = await supabase.storage
        .from(FILES_BUCKET)
        .upload(path, i.file, { contentType: mime, upsert: false, cacheControl: '300' })
      if (up.error) throw await storageRefusal(storageError(up.error as StorageErr, 'send'))
      const { data, error } = await supabase.rpc('attach_file', {
        p_encounter_id: i.encounterId,
        p_path: path,
        p_kind: i.kind,
        p_title: i.title.trim(),
        p_mime: mime,
        p_size: i.file.size,
        p_service_request_id: i.serviceRequestId ?? null,
        p_note: i.note?.trim() || null,
      })
      if (error) {
        // not registered: take the file back out of Storage (allowed for an unregistered upload)
        await supabase.storage
          .from(FILES_BUCKET)
          .remove([path])
          .catch(() => undefined)
        if (isMissingFunction(error)) throw sampleRefusal('filesUnavailable', 'PGRST202')
        throw apiError(error)
      }
      return data as PatientFileDoc
    },
    onSuccess: refresh,
  })

  const open = useMutation({
    mutationFn: openFileLink,
    // opening a past visit's file is logged
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['privacy'] }),
  })

  const remove = useMutation({
    mutationFn: async (i: RemoveFileInput): Promise<RemovedFile> => {
      if (i.reason.trim().length < 3) throw sampleRefusal('reasonNeeded', '22023')
      if (!supabase) {
        const u = me()
        const f = sampleStore().find((x) => x.id === i.fileId)
        if (!f) throw sampleRefusal('notFound', 'P0002')
        if (f.removed) throw sampleRefusal('alreadyRemoved', '22023')
        if (!sampleManager()) {
          if (f.uploadedById !== u?.id) throw sampleRefusal('notUploader', '42501')
          if (Date.now() - new Date(f.uploadedAt).getTime() >= 24 * 3600_000)
            throw sampleRefusal('removeTooLate', '42501')
        }
        const removedAt = new Date().toISOString()
        sampleFiles = sampleStore().map((x) =>
          x.id === f.id
            ? {
                ...x,
                removed: true,
                removedAt,
                removedBy: u?.name ?? null,
                removeReason: i.reason.trim(),
              }
            : x,
        )
        return { id: f.id, removedAt, storageLeft: false }
      }
      const { data, error } = await supabase.rpc('remove_file', {
        p_file_id: i.fileId,
        p_reason: i.reason.trim(),
      })
      if (error) {
        if (isMissingFunction(error)) throw sampleRefusal('filesUnavailable', 'PGRST202')
        throw apiError(error)
      }
      const r = data as { id: string; path: string; removedAt: string }
      // the row stays (removed, with the reason); the file itself goes from Storage. storage-js
      // does not throw: a refused delete gives an empty list, a failed one an error. Either way
      // the copy is left, which the screen says (the manager can finish it: purge).
      const del = await supabase.storage
        .from(FILES_BUCKET)
        .remove([r.path])
        .catch(() => ({ data: null, error: new Error('network') }))
      return { id: r.id, removedAt: r.removedAt, storageLeft: !!del.error || !del.data?.length }
    },
    onSuccess: refresh,
  })

  /** The manager deletes the stored copy of a removed file that stayed in storage. */
  const purge = useMutation({
    mutationFn: async (f: Pick<PatientFileDoc, 'id' | 'path'>): Promise<void> => {
      if (!supabase) return
      const del = await supabase.storage.from(FILES_BUCKET).remove([f.path])
      if (del.error || !del.data?.length) throw sampleRefusal('storageNotDeleted', '42501')
    },
    onSettled: refresh,
  })

  return { attach, open, remove, purge }
}
