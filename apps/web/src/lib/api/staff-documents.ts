import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, apiError, isMissingFunction, sampleRefusal, type ApiErrorKind } from './errors'
import type { OpenedFile } from './files'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'

/**
 * Employee document files (migration 0116): the manager keeps, for each employee, their licence,
 * the contract signed, an identity document, certificates, a CV and other crucial papers, in the
 * clinic's PRIVATE Storage bucket `staff-files` at `<profile id>/<document id>.<ext>`; the
 * database keeps one row per file.
 *
 * Who: the MANAGER adds, sees, opens and removes anyone's documents (every look at another
 * person's is written to the audit log, so it can be reviewed); an EMPLOYEE sees and opens their
 * own, read only; nobody else sees anything. A document is opened through a link valid 5
 * minutes (staff_document_open checks and logs, then Storage signs the link, its own policy
 * checking again). Removing: the manager, always with a reason; the row stays.
 *
 * Older databases (before 0116) have none of these functions: the lists are empty and
 * `available` is false (the screens say the update is not installed). Sample mode keeps the
 * documents in memory, with a few for two sample employees.
 */

export type StaffDocKind = 'licence' | 'contract' | 'id' | 'certificate' | 'cv' | 'other'
export const STAFF_DOC_KINDS: readonly StaffDocKind[] = [
  'licence',
  'contract',
  'id',
  'certificate',
  'cv',
  'other',
]
/** The kinds that expire (a date is asked for): the licence and the contract. */
export const EXPIRING_KINDS: readonly StaffDocKind[] = ['licence', 'contract']
export type StaffDocMime =
  | 'application/pdf'
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'application/msword'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const STAFF_DOC_TYPES: readonly StaffDocMime[] = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]
/** 10 MB. */
export const STAFF_DOC_MAX_BYTES = 10 * 1024 * 1024
/** For <input type="file" accept=…>. */
export const STAFF_DOC_ACCEPT =
  '.pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,application/pdf,image/jpeg,image/png,image/webp,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document'
/** How long an opened link works. */
export const STAFF_DOC_LINK_SECONDS = 300
export const STAFF_FILES_BUCKET = 'staff-files'
/** A licence or contract expiring within this many days is "expiring soon" (amber). */
export const EXPIRING_DAYS = 60

/** One document of an employee. */
export interface StaffDocument {
  id: string
  profileId: string
  profileName: string | null
  kind: StaffDocKind
  title: string
  note: string | null
  mimeType: StaffDocMime
  sizeBytes: number
  /** Storage path (not a link: open it with openStaffDocumentLink). */
  path: string
  /** ISO date, when the document expires (a licence, a contract); null when it does not. */
  expiresOn: string | null
  expired: boolean
  /** Days until it expires (negative when expired); null without a date. */
  daysLeft: number | null
  uploadedById: string
  uploadedBy: string | null
  uploadedAt: string
  /** Removed documents are listed for the manager only. */
  removed: boolean
  removedAt: string | null
  removedBy: string | null
  removeReason: string | null
  /** A removed document whose copy is still in storage (the delete failed): the manager deletes
   *  it. Null where unknown. */
  storageLeft?: boolean | null
  /** The manager, while the document is not removed. */
  canRemove: boolean
}

export interface StaffDocumentsList {
  profileId: string
  profileName: string | null
  /** The documents the person may see, newest first (the removed ones last, the manager only). */
  documents: StaffDocument[]
  /** Removed documents (listed for the manager). */
  removed: number
  /** The manager. */
  canAdd: boolean
  maxBytes: number
  types: StaffDocMime[]
  /** False when the database is older than 0116 (no documents at all). */
  available: boolean
}

/** A licence or contract expiring soon, or expired (the manager's dashboard). */
export interface ExpiringStaffDocument {
  id: string
  profileId: string
  profileName: string
  role: string
  kind: StaffDocKind
  title: string
  expiresOn: string
  daysLeft: number
  expired: boolean
}

export interface AddStaffDocumentInput {
  profileId: string
  file: File
  kind: StaffDocKind
  title: string
  /** ISO date or null. */
  expiresOn?: string | null
  note?: string | null
}
export interface RemoveStaffDocumentInput {
  documentId: string
  reason: string
}
export interface RemovedStaffDocument {
  id: string
  removedAt: string
  /** The row is removed but the copy in storage could not be deleted (the manager finishes it). */
  storageLeft: boolean
}

const KEY = ['staff-documents'] as const

// ---------------------------------------------------------------- checks before sending
/** The type a browser gives, made exact ('' or image/jpg from some phones). */
export function staffDocMime(file: Pick<File, 'type' | 'name'>): StaffDocMime | null {
  const t = (file.type || '').toLowerCase()
  if (t === 'image/jpg' || t === 'image/pjpeg') return 'image/jpeg'
  if ((STAFF_DOC_TYPES as readonly string[]).includes(t)) return t as StaffDocMime
  const ext = file.name.toLowerCase().split('.').pop() ?? ''
  // Word files often come with an empty or odd type: the extension decides
  if (ext === 'doc') return 'application/msword'
  if (ext === 'docx')
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (t) return null
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'pdf') return 'application/pdf'
  return null
}
const EXT: Record<StaffDocMime, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
}
/** Why the file cannot be sent (staffDocType, fileTooBig, fileEmpty), or null. */
export function checkStaffDoc(file: Pick<File, 'type' | 'name' | 'size'>): ApiErrorKind | null {
  if (!staffDocMime(file)) return 'staffDocType'
  if (file.size <= 0) return 'fileEmpty'
  if (file.size > STAFF_DOC_MAX_BYTES) return 'fileTooBig'
  return null
}
export const isWordDoc = (mime: string) =>
  mime.startsWith('application/msword') || mime.includes('wordprocessingml')

/** Today's ISO date (the clinic's clock). */
const todayIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** Whole days from today to an ISO date (negative when past). */
export const daysUntil = (iso: string): number =>
  Math.round(
    (new Date(`${iso}T00:00:00`).getTime() - new Date(`${todayIso()}T00:00:00`).getTime()) /
      86_400_000,
  )
/** How the expiry is shown: red when expired, amber within 60 days, else plain. */
export const expiryTone = (d: Pick<StaffDocument, 'expiresOn' | 'daysLeft' | 'expired'>) => {
  if (!d.expiresOn) return null
  const left = d.daysLeft ?? daysUntil(d.expiresOn)
  if (d.expired || left < 0) return 'expired' as const
  if (left <= EXPIRING_DAYS) return 'soon' as const
  return 'ok' as const
}

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
/** A Storage refusal in clinic words: sending or opening. */
const storageError = (e: StorageErr, ctx: 'send' | 'open'): ApiError => {
  const m = e?.message ?? ''
  const status = String(e?.statusCode ?? '')
  if (/bucket not found/i.test(m)) return sampleRefusal('staffDocsUnavailable', 'P0002')
  const refused = /row-level security|unauthori[sz]ed|not allowed/i.test(m) || status === '403'
  if (ctx === 'open') {
    if (refused) return sampleRefusal('staffDocPrivate', '42501')
    if (/not found/i.test(m) || status === '400' || status === '404')
      return sampleRefusal('notFound', 'P0002')
    return apiError({ message: m || 'The document could not be opened', code: status || null })
  }
  if (/maximum allowed size|too large/i.test(m) || status === '413')
    return sampleRefusal('fileTooBig', '22023')
  if (/mime type|not supported/i.test(m) || status === '415')
    return sampleRefusal('staffDocType', '22023')
  if (refused) return sampleRefusal('staffDocManagerOnly', '42501')
  return apiError({ message: m || 'The document could not be sent', code: status || null })
}
/** Storage also refuses when the session needs the e-mailed code again (0081). */
const storageRefusal = async (e: ApiError): Promise<ApiError> => {
  if (!supabase || (e.kind !== 'staffDocManagerOnly' && e.kind !== 'staffDocPrivate')) return e
  const st = await supabase.rpc('session_status')
  const ok = (st.data as { ok?: boolean } | null)?.ok
  return !st.error && ok === false ? sampleRefusal('sessionExpired', '42501') : e
}

// ---------------------------------------------------------------- sample data
const me = () => useSession.getState().user
const sampleManager = () => {
  const u = me()
  return !u || u.role === 'manager'
}
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
const dateIn = (n: number) => {
  const d = new Date(Date.now() + n * 86_400_000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const svgUrl = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
/** A scanned identity card (SVG). */
const sampleCard = (name: string) =>
  svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500"><rect width="800" height="500" rx="24" fill="#e8eef5"/><rect x="40" y="40" width="200" height="240" rx="12" fill="#b9c6d6"/><circle cx="140" cy="130" r="54" fill="#8a9bb0"/><path d="M60 280 q80 -90 160 0 Z" fill="#8a9bb0"/><text x="280" y="90" fill="#1f2937" font-family="sans-serif" font-size="30" font-weight="bold">REPUBLIC OF RWANDA</text><text x="280" y="130" fill="#374151" font-family="sans-serif" font-size="22">NATIONAL ID · SAMPLE</text><text x="280" y="200" fill="#111827" font-family="sans-serif" font-size="26">${name}</text>${[
      0, 1, 2, 3,
    ]
      .map(
        (i) =>
          `<rect x="280" y="${230 + i * 36}" width="${260 + ((i * 53) % 160)}" height="12" rx="6" fill="#9ca3af"/>`,
      )
      .join(
        '',
      )}<rect x="40" y="400" width="720" height="50" rx="8" fill="#374151"/><text x="60" y="434" fill="#f9fafb" font-family="monospace" font-size="24">1 1990 8 0012345 0 12</text></svg>`,
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

interface SampleDoc extends Omit<StaffDocument, 'canRemove' | 'expired' | 'daysLeft'> {
  url: string
}
let sampleDocs: SampleDoc[] | null = null
const sampleStore = (): SampleDoc[] => {
  if (sampleDocs) return sampleDocs
  const base = {
    note: null,
    removed: false,
    removedAt: null,
    removedBy: null,
    removeReason: null,
    uploadedById: 'u-mgr',
    uploadedBy: 'Mugabo Théogène',
  }
  // the nurse (u-nur): a licence expiring soon, a contract, her ID; the doctor (u-doc): an
  // expired licence, a contract, a certificate
  sampleDocs = [
    {
      ...base,
      id: 'sd-1',
      profileId: 'u-nur',
      profileName: 'Nyirahabimana Chantal',
      kind: 'licence',
      title: 'NCNM practising licence 2026',
      note: 'Renewed every year in March',
      mimeType: 'application/pdf',
      sizeBytes: 182_000,
      path: 'u-nur/sd-1.pdf',
      expiresOn: dateIn(24),
      uploadedAt: daysAgo(200),
      url: samplePdf([
        'National Council of Nurses and Midwives - SAMPLE',
        'Practising licence',
        'Name: Nyirahabimana Chantal',
        'Registration: NCNM 2019/1123',
        `Valid until ${dateIn(24)}`,
      ]),
    },
    {
      ...base,
      id: 'sd-2',
      profileId: 'u-nur',
      profileName: 'Nyirahabimana Chantal',
      kind: 'contract',
      title: 'Employment contract 2025-2027',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 64_000,
      path: 'u-nur/sd-2.docx',
      expiresOn: dateIn(410),
      uploadedAt: daysAgo(300),
      url: 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,UEsDBAoAAAAAAA==',
    },
    {
      ...base,
      id: 'sd-3',
      profileId: 'u-nur',
      profileName: 'Nyirahabimana Chantal',
      kind: 'id',
      title: 'National ID card',
      mimeType: 'image/png',
      sizeBytes: 410_000,
      path: 'u-nur/sd-3.png',
      expiresOn: null,
      uploadedAt: daysAgo(300),
      url: sampleCard('NYIRAHABIMANA Chantal'),
    },
    {
      ...base,
      id: 'sd-4',
      profileId: 'u-doc',
      profileName: 'Dr. Mukamana Béatrice',
      kind: 'licence',
      title: 'RMDC licence to practise',
      mimeType: 'application/pdf',
      sizeBytes: 150_000,
      path: 'u-doc/sd-4.pdf',
      expiresOn: dateIn(-12),
      uploadedAt: daysAgo(380),
      url: samplePdf([
        'Rwanda Medical and Dental Council - SAMPLE',
        'Licence to practise',
        'Name: Dr Mukamana Beatrice',
        'Registration: RMDC 2017/0458',
        `Valid until ${dateIn(-12)}`,
      ]),
    },
    {
      ...base,
      id: 'sd-5',
      profileId: 'u-doc',
      profileName: 'Dr. Mukamana Béatrice',
      kind: 'contract',
      title: 'Employment contract 2024-2026',
      mimeType: 'application/pdf',
      sizeBytes: 220_000,
      path: 'u-doc/sd-5.pdf',
      expiresOn: dateIn(45),
      uploadedAt: daysAgo(700),
      url: samplePdf([
        'Muhazi Medical Clinic - Employment contract - SAMPLE',
        'Employee: Dr Mukamana Beatrice',
        'Position: General practitioner',
        `Ends on ${dateIn(45)}`,
      ]),
    },
    {
      ...base,
      id: 'sd-6',
      profileId: 'u-doc',
      profileName: 'Dr. Mukamana Béatrice',
      kind: 'certificate',
      title: 'Certificate in ultrasound (2023)',
      mimeType: 'image/png',
      sizeBytes: 520_000,
      path: 'u-doc/sd-6.png',
      expiresOn: null,
      uploadedAt: daysAgo(400),
      url: sampleCard('Certificate - Dr MUKAMANA'),
    },
  ]
  return sampleDocs
}
/** The row the screens get (the sample link stays in memory). */
const sampleRow = (d: SampleDoc): StaffDocument => {
  const c: Partial<SampleDoc> = { ...d }
  delete c.url
  const left = d.expiresOn ? daysUntil(d.expiresOn) : null
  return {
    ...(c as Omit<SampleDoc, 'url'>),
    expired: left != null && left < 0,
    daysLeft: left,
    canRemove: !d.removed && sampleManager(),
  }
}
const sampleMaySee = (profileId: string) => sampleManager() || me()?.id === profileId
const sampleName = (profileId: string) =>
  sampleStore().find((d) => d.profileId === profileId)?.profileName ??
  (me()?.id === profileId ? (me()?.name ?? null) : null)
const sampleList = (profileId: string): StaffDocumentsList => ({
  profileId,
  profileName: sampleName(profileId),
  documents: sampleStore()
    .filter((d) => d.profileId === profileId && (!d.removed || sampleManager()))
    .sort(
      (a, b) =>
        Number(a.removed) - Number(b.removed) ||
        new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
    )
    .map(sampleRow),
  removed: sampleStore().filter((d) => d.profileId === profileId && d.removed).length,
  canAdd: sampleManager(),
  maxBytes: STAFF_DOC_MAX_BYTES,
  types: [...STAFF_DOC_TYPES],
  available: true,
})

const EMPTY = (profileId: string): StaffDocumentsList => ({
  profileId,
  profileName: null,
  documents: [],
  removed: 0,
  canAdd: false,
  maxBytes: STAFF_DOC_MAX_BYTES,
  types: [...STAFF_DOC_TYPES],
  available: false,
})

// ---------------------------------------------------------------- reading
/** The documents of one employee (the manager: anyone; an employee: themselves). */
export function useStaffDocuments(profileId: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'of', profileId],
    enabled: enabled && !!profileId,
    refetchInterval: 60_000,
    queryFn: async (): Promise<StaffDocumentsList> => {
      if (!supabase) {
        if (!sampleMaySee(profileId!)) throw sampleRefusal('staffDocPrivate', '42501')
        return sampleList(profileId!)
      }
      const { data, error } = await supabase.rpc('staff_documents', { p_profile: profileId })
      if (error) {
        if (isMissingFunction(error)) return EMPTY(profileId!)
        throw apiError(error)
      }
      return { ...(data as Omit<StaffDocumentsList, 'available'>), available: true }
    },
  })
}

/** The manager's dashboard: licences and contracts expired or expiring within 60 days. */
export function useExpiringStaffDocuments(enabled = true, days = EXPIRING_DAYS) {
  return useQuery({
    queryKey: [...KEY, 'expiring', days],
    enabled,
    refetchInterval: 5 * 60_000,
    queryFn: async (): Promise<ExpiringStaffDocument[]> => {
      if (!supabase) {
        if (!sampleManager()) throw sampleRefusal('staffDocManagerOnly', '42501')
        return sampleStore()
          .filter(
            (d) =>
              !d.removed &&
              EXPIRING_KINDS.includes(d.kind) &&
              d.expiresOn &&
              daysUntil(d.expiresOn) <= days,
          )
          .map((d) => ({
            id: d.id,
            profileId: d.profileId,
            profileName: d.profileName ?? '',
            role: d.profileId === 'u-doc' ? 'doctor' : 'nurse',
            kind: d.kind,
            title: d.title,
            expiresOn: d.expiresOn!,
            daysLeft: daysUntil(d.expiresOn!),
            expired: daysUntil(d.expiresOn!) < 0,
          }))
          .sort((a, b) => a.daysLeft - b.daysLeft)
      }
      const { data, error } = await supabase.rpc('staff_documents_expiring', { p_days: days })
      if (error) {
        if (isMissingFunction(error)) return []
        throw apiError(error)
      }
      return (data ?? []) as ExpiringStaffDocument[]
    },
  })
}

// ---------------------------------------------------------------- the 5-minute link
/**
 * A link to one document, valid 5 minutes: staff_document_open checks (and logs the manager's
 * opening of another person's), then Storage signs the link. Sample mode gives the document
 * kept in memory.
 */
export async function openStaffDocumentLink(documentId: string): Promise<OpenedFile> {
  const expiresAt = new Date(Date.now() + STAFF_DOC_LINK_SECONDS * 1000).toISOString()
  if (!supabase) {
    const d = sampleStore().find((x) => x.id === documentId)
    if (!d || !sampleMaySee(d.profileId)) throw sampleRefusal('notFound', 'P0002')
    if (d.removed) throw sampleRefusal('alreadyRemoved', '22023')
    return { id: d.id, url: d.url, mimeType: d.mimeType, title: d.title, expiresAt }
  }
  const { data, error } = await supabase.rpc('staff_document_open', { p_id: documentId })
  if (error) {
    if (isMissingFunction(error)) throw sampleRefusal('staffDocsUnavailable', 'PGRST202')
    throw apiError(error)
  }
  const o = data as { path: string; mimeType: StaffDocMime; title: string; expiresIn?: number }
  const signed = await supabase.storage
    .from(STAFF_FILES_BUCKET)
    .createSignedUrl(o.path, o.expiresIn ?? STAFF_DOC_LINK_SECONDS)
  if (signed.error || !signed.data?.signedUrl)
    throw await storageRefusal(storageError(signed.error as StorageErr, 'open'))
  return {
    id: documentId,
    url: signed.data.signedUrl,
    mimeType: o.mimeType,
    title: o.title,
    expiresAt,
  }
}

// ---------------------------------------------------------------- acting
/**
 * add: checks the type and size, sends the file to Storage, then registers it
 * (add_staff_document); if registering is refused, the file just sent is deleted again.
 * remove: soft removal with a reason (the manager), then the file is deleted from Storage.
 * purge: the manager deletes the stored copy a removal left behind.
 */
export function useStaffDocumentActions() {
  const qc = useQueryClient()
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY })

  const add = useMutation({
    mutationFn: async (i: AddStaffDocumentInput): Promise<StaffDocument> => {
      const bad = checkStaffDoc(i.file)
      if (bad) throw sampleRefusal(bad, '22023')
      if (!i.title.trim()) throw sampleRefusal('titleNeeded', '22023')
      const mime = staffDocMime(i.file)!
      const id = uuid()
      const path = `${i.profileId}/${id}.${EXT[mime]}`
      if (!supabase) {
        if (!sampleManager()) throw sampleRefusal('staffDocManagerOnly', '42501')
        const u = me()
        const row: SampleDoc = {
          id,
          profileId: i.profileId,
          profileName: sampleName(i.profileId),
          kind: i.kind,
          title: i.title.trim(),
          note: i.note?.trim() || null,
          mimeType: mime,
          sizeBytes: i.file.size,
          path,
          expiresOn: i.expiresOn || null,
          uploadedById: u?.id ?? 'u-mgr',
          uploadedBy: u?.name ?? null,
          uploadedAt: new Date().toISOString(),
          removed: false,
          removedAt: null,
          removedBy: null,
          removeReason: null,
          url: URL.createObjectURL(i.file),
        }
        sampleDocs = [row, ...sampleStore()]
        return sampleRow(row)
      }
      const up = await supabase.storage
        .from(STAFF_FILES_BUCKET)
        .upload(path, i.file, { contentType: mime, upsert: false, cacheControl: '300' })
      if (up.error) throw await storageRefusal(storageError(up.error as StorageErr, 'send'))
      const { data, error } = await supabase.rpc('add_staff_document', {
        p_profile: i.profileId,
        p_kind: i.kind,
        p_title: i.title.trim(),
        p_path: path,
        p_mime: mime,
        p_size: i.file.size,
        p_expires_on: i.expiresOn || null,
        p_note: i.note?.trim() || null,
      })
      if (error) {
        // not registered: take the file back out of Storage (allowed for an unregistered upload)
        await supabase.storage
          .from(STAFF_FILES_BUCKET)
          .remove([path])
          .catch(() => undefined)
        if (isMissingFunction(error)) throw sampleRefusal('staffDocsUnavailable', 'PGRST202')
        throw apiError(error)
      }
      return data as StaffDocument
    },
    onSuccess: refresh,
  })

  const remove = useMutation({
    mutationFn: async (i: RemoveStaffDocumentInput): Promise<RemovedStaffDocument> => {
      if (i.reason.trim().length < 3) throw sampleRefusal('reasonNeeded', '22023')
      if (!supabase) {
        const u = me()
        const d = sampleStore().find((x) => x.id === i.documentId)
        if (!d) throw sampleRefusal('notFound', 'P0002')
        if (!sampleManager()) throw sampleRefusal('staffDocManagerOnly', '42501')
        if (d.removed) throw sampleRefusal('alreadyRemoved', '22023')
        const removedAt = new Date().toISOString()
        sampleDocs = sampleStore().map((x) =>
          x.id === d.id
            ? {
                ...x,
                removed: true,
                removedAt,
                removedBy: u?.name ?? null,
                removeReason: i.reason.trim(),
              }
            : x,
        )
        return { id: d.id, removedAt, storageLeft: false }
      }
      const { data, error } = await supabase.rpc('remove_staff_document', {
        p_id: i.documentId,
        p_reason: i.reason.trim(),
      })
      if (error) {
        if (isMissingFunction(error)) throw sampleRefusal('staffDocsUnavailable', 'PGRST202')
        throw apiError(error)
      }
      const r = data as { id: string; path: string; removedAt: string }
      // the row stays (removed, with the reason); the file itself goes from Storage. A refused
      // delete gives an empty list, a failed one an error: either way the copy is left, which
      // the screen says (the manager can finish it: purge).
      const del = await supabase.storage
        .from(STAFF_FILES_BUCKET)
        .remove([r.path])
        .catch(() => ({ data: null, error: new Error('network') }))
      return { id: r.id, removedAt: r.removedAt, storageLeft: !!del.error || !del.data?.length }
    },
    onSuccess: refresh,
  })

  /** The manager deletes the stored copy of a removed document that stayed in storage. */
  const purge = useMutation({
    mutationFn: async (d: Pick<StaffDocument, 'id' | 'path'>): Promise<void> => {
      if (!supabase) return
      const del = await supabase.storage.from(STAFF_FILES_BUCKET).remove([d.path])
      if (del.error || !del.data?.length) throw sampleRefusal('storageNotDeleted', '42501')
    },
    onSettled: refresh,
  })

  return { add, remove, purge }
}
