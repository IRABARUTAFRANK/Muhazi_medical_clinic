import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { samplePermsOf } from './permissions'
import { apiError, isMissingFunction, sampleRefusal } from './errors'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'

/**
 * Patient record privacy (migration 0088).
 *
 * Four levels: 1 identity (every employee), 2 safety summary (whoever treats the patient now),
 * 3 this visit (the people working on it), 4 full history (the manager, the head of a department
 * in charge, the clinician for the visits they treated, an approved request or an emergency
 * access until the current visit closes). The database returns only what the level allows and
 * logs every opening of past records. Someone treating the patient asks for access (the manager
 * or a head in charge answers) or opens it at once in an emergency (the manager reviews it).
 *
 * Older databases (before 0088) have none of these functions: everything stays visible as
 * before (`LEGACY_ACCESS`), the requests and the log are empty.
 */

export type AccessLevel = 'identity' | 'summary' | 'full'
/** How the whole history is seen. */
export type AccessVia = 'manager' | 'head' | 'request' | 'emergency'
/** How one visit's clinical record is seen: 'visit' = today's, working on it; 'own' = treated it. */
export type VisitView = 'visit' | 'own' | AccessVia
/** How past records were opened (the access log). */
export type AccessLogVia = 'own' | AccessVia
export type AccessRequestStatus = 'pending' | 'approved' | 'refused' | 'cancelled'
export type AccessRequestKind = 'request' | 'emergency'

/** The requester's latest request for the visit they treat now. */
export interface AccessRequestBrief {
  id: string
  kind: AccessRequestKind
  status: AccessRequestStatus
  reason: string
  at: string
  answeredAt: string | null
  answerNote: string | null
  answeredBy: string | null
}

/** What the signed-in person may see of a patient, and may ask for (patient_access). */
export interface PatientAccess {
  level: AccessLevel
  /** How the whole history is seen; null = not at all (own visits may still be seen). */
  via: AccessVia | null
  /** The open visit this person treats now (needed to request or open an emergency access). */
  treatingEncounterId: string | null
  /** Closed visits of the patient; those this person treated; those they cannot see. */
  pastVisits: number
  ownVisits: number
  hiddenVisits: number
  /** Show "Request access" / "Emergency access". */
  canRequest: boolean
  canEmergency: boolean
  /** May read "Who looked" (patient_access_log): the manager and the heads in charge. */
  canSeeLog: boolean
  request: AccessRequestBrief | null
  /** True when the database is older than 0088 (no privacy: everything visible). */
  legacy?: boolean
}

/** The safety summary (level 2). */
export interface SafetySummary {
  allergies: string | null
  allergiesNone: boolean
  bloodGroup: string | null
  /** The patient notes (alerts written on the file). */
  alerts: string | null
  flags: Record<string, unknown>
  /** Chronic ICD-10 groups, or the same diagnosis on two visits. */
  chronic: { text: string; icd10: string | null; since: string; lastAt: string }[]
  /** Medicines of the open visit and those whose prescribed days are not over. */
  medications: {
    item: string
    dose: string | null
    frequency: string | null
    days: number | null
    at: string
    until: string | null
    by: string | null
  }[]
  /** The last value of each vital sign. */
  lastVitals: {
    code: string
    value: number | null
    unit: string | null
    at: string
    by: string | null
  }[]
  lastVisitAt: string | null
}

/** A request or emergency access (record_access_requests). */
export interface AccessRequestRow {
  id: string
  kind: AccessRequestKind
  status: AccessRequestStatus
  patientId: string
  patient: string
  fileNumber: string | null
  encounterId: string
  visitReference: string | null
  visitOpen: boolean
  requestedById: string
  requestedBy: string
  requestedByRole: string
  reason: string
  at: string
  answeredBy: string | null
  answeredAt: string | null
  answerNote: string | null
  /** Approved and the visit still open: the requester sees the past records now. */
  active: boolean
  mine: boolean
  canAnswer: boolean
  canCancel: boolean
  reviewedBy: string | null
  reviewedAt: string | null
  reviewNote: string | null
  /** An emergency access the manager has not reviewed yet. */
  canReview: boolean
}
/** 'pending': waiting for my answer; 'mine': my own; 'emergency'; 'all' I may see (90 days). */
export type AccessRequestScope = 'pending' | 'mine' | 'emergency' | 'all'

/** One opening of past records (record_access_log, patient_access_log). */
export interface AccessLogRow {
  id: string
  at: string
  actorId: string
  actor: string | null
  actorRole: string | null
  patientId: string
  patient: string
  fileNumber: string | null
  /** The past visit opened; null = the patient file or all results. */
  encounterId: string | null
  visitReference: string | null
  via: AccessLogVia
  /** 'attachment' (0089): a supporting file of a past visit was opened. */
  what: 'file' | 'visit' | 'results' | 'journey' | 'emergency' | 'attachment'
  requestId: string | null
  /** The reason of the request or emergency behind it. */
  reason: string | null
  /** Shown in red. */
  emergency: boolean
  reviewed: boolean
  reviewedBy: string | null
  reviewNote: string | null
}
export interface AccessLogFilter {
  /** ISO dates; default the last 30 days. */
  from?: string | null
  to?: string | null
  patientId?: string | null
  actorId?: string | null
  via?: AccessLogVia | null
  limit?: number
  offset?: number
}
export interface AccessLogPage {
  total: number
  rows: AccessLogRow[]
  /** Emergency accesses not reviewed yet (the whole clinic). */
  unreviewed: number
}

/** Before 0088: no levels, everything visible as before. */
export const LEGACY_ACCESS: PatientAccess = {
  level: 'full',
  via: null,
  treatingEncounterId: null,
  pastVisits: 0,
  ownVisits: 0,
  hiddenVisits: 0,
  canRequest: false,
  canEmergency: false,
  canSeeLog: false,
  request: null,
  legacy: true,
}

const KEY = ['privacy'] as const

// ---------------------------------------------------------------- sample data
const me = () => useSession.getState().user
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
/** Sample requests: one waiting for the manager, one refused, one reviewed emergency. */
let sampleRequests: AccessRequestRow[] = [
  {
    id: 'ar-1',
    kind: 'request',
    status: 'pending',
    patientId: 'p-3',
    patient: 'Niyonzima Jean Bosco',
    fileNumber: 'MMC-000140',
    encounterId: 'e-3',
    visitReference: 'V-2026-000131',
    visitOpen: true,
    requestedById: 'u-nur',
    requestedBy: 'Nyirahabimana Chantal',
    requestedByRole: 'nurse',
    reason: 'High blood pressure today: what was he treated with before?',
    at: minutesAgo(12),
    answeredBy: null,
    answeredAt: null,
    answerNote: null,
    active: false,
    mine: false,
    canAnswer: true,
    canCancel: false,
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    canReview: false,
  },
  {
    id: 'ar-2',
    kind: 'emergency',
    status: 'approved',
    patientId: 'p-1',
    patient: 'Mukamana Alice',
    fileNumber: 'MMC-000124',
    encounterId: 'e-7',
    visitReference: 'V-2026-000118',
    visitOpen: false,
    requestedById: 'u-doc',
    requestedBy: 'Dr. Mukamana Béatrice',
    requestedByRole: 'doctor',
    reason: 'Arrived unconscious: needed her previous medicines and allergies',
    at: minutesAgo(60 * 26),
    answeredBy: null,
    answeredAt: minutesAgo(60 * 26),
    answerNote: null,
    active: false,
    mine: false,
    canAnswer: false,
    canCancel: false,
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    canReview: true,
  },
]
let sampleLog: AccessLogRow[] = [
  {
    id: 'al-1',
    at: minutesAgo(60 * 26),
    actorId: 'u-doc',
    actor: 'Dr. Mukamana Béatrice',
    actorRole: 'doctor',
    patientId: 'p-1',
    patient: 'Mukamana Alice',
    fileNumber: 'MMC-000124',
    encounterId: null,
    visitReference: null,
    via: 'emergency',
    what: 'emergency',
    requestId: 'ar-2',
    reason: 'Arrived unconscious: needed her previous medicines and allergies',
    emergency: true,
    reviewed: false,
    reviewedBy: null,
    reviewNote: null,
  },
  {
    id: 'al-2',
    at: minutesAgo(60 * 3),
    actorId: 'u-head',
    actor: 'Dr. Ndayisaba Félix',
    actorRole: 'doctor',
    patientId: 'p-3',
    patient: 'Niyonzima Jean Bosco',
    fileNumber: 'MMC-000140',
    encounterId: null,
    visitReference: null,
    via: 'head',
    what: 'file',
    requestId: null,
    reason: null,
    emergency: false,
    reviewed: false,
    reviewedBy: null,
    reviewNote: null,
  },
  {
    id: 'al-3',
    at: minutesAgo(45),
    actorId: 'u-mgr',
    actor: 'Mugabo Théogène',
    actorRole: 'manager',
    patientId: 'p-2',
    patient: 'Habimana Eric',
    fileNumber: 'MMC-000131',
    encounterId: 'e-8',
    visitReference: 'V-2026-000097',
    via: 'manager',
    what: 'visit',
    requestId: null,
    reason: null,
    emergency: false,
    reviewed: false,
    reviewedBy: null,
    reviewNote: null,
  },
]
const sampleIsHead = () => !!me()?.headOf
/** Sample mode: may the person answer record-access requests? The manager, or the sample switch
 *  "Answer record-access requests" (0095). */
const sampleMayAnswer = () => {
  const u = me()
  return (
    !!u && (u.role === 'manager' || samplePermsOf(u.id, u.dbRole ?? u.role).has('records.approve'))
  )
}
const TREATS = new Set(['doctor', 'nurse'])

/** The sample access in force for the patient (approved, its visit open). */
const sampleInForce = (patientId: string) => {
  const u = me()
  return sampleRequests.find(
    (r) =>
      r.patientId === patientId &&
      r.requestedById === (u?.id ?? '') &&
      r.status === 'approved' &&
      r.visitOpen,
  )
}

/** The sample person's access to a sample patient (used by the patient file in sample mode). */
export function sampleAccess(
  patientId: string,
  visits: { id: string; status: 'open' | 'closed' }[],
): PatientAccess {
  const u = me()
  const open = visits.find((v) => v.status === 'open') ?? null
  const past = visits.filter((v) => v.status === 'closed').length
  const via: AccessVia | null =
    !u || u.role === 'manager'
      ? 'manager'
      : sampleIsHead()
        ? 'head'
        : ((sampleInForce(patientId)?.kind as AccessVia | undefined) ?? null)
  const treating = open && u && TREATS.has(u.role) ? open.id : null
  const mine = treating
    ? sampleRequests.find(
        (r) => r.patientId === patientId && r.encounterId === treating && r.requestedById === u?.id,
      )
    : undefined
  const hidden = via ? 0 : past
  return {
    level: via ? 'full' : treating ? 'summary' : 'identity',
    via,
    treatingEncounterId: treating,
    pastVisits: past,
    ownVisits: 0,
    hiddenVisits: hidden,
    canRequest:
      !!treating &&
      !via &&
      hidden > 0 &&
      (!mine || mine.status === 'refused' || mine.status === 'cancelled'),
    canEmergency: !!treating && !via && hidden > 0,
    canSeeLog: !u || u.role === 'manager' || sampleIsHead(),
    request: mine
      ? {
          id: mine.id,
          kind: mine.kind,
          status: mine.status,
          reason: mine.reason,
          at: mine.at,
          answeredAt: mine.answeredAt,
          answerNote: mine.answerNote,
          answeredBy: mine.answeredBy,
        }
      : null,
  }
}

/** How the sample person sees one sample visit (null = private). */
export function sampleVisitView(
  access: PatientAccess,
  visit: { id: string; status: 'open' | 'closed' },
): VisitView | null {
  if (visit.status === 'open') {
    const u = me()
    if (!u || u.role === 'manager' || access.treatingEncounterId === visit.id) return 'visit'
    return access.via
  }
  return access.via
}

const samplePatientName: Record<string, [string, string]> = {
  'p-1': ['Mukamana Alice', 'MMC-000124'],
  'p-2': ['Habimana Eric', 'MMC-000131'],
  'p-3': ['Niyonzima Jean Bosco', 'MMC-000140'],
}

// ---------------------------------------------------------------- reading
/** What the signed-in person may see of the patient and may ask for. */
export function usePatientAccess(patientId: string, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'access', patientId],
    enabled: enabled && !!patientId,
    refetchInterval: 30_000,
    queryFn: async (): Promise<PatientAccess> => {
      if (!supabase) return sampleAccess(patientId, [])
      const { data, error } = await supabase.rpc('patient_access', { p_patient_id: patientId })
      if (error) {
        if (isMissingFunction(error)) return LEGACY_ACCESS
        throw apiError(error)
      }
      return data as PatientAccess
    },
  })
}

/** The requests and emergency accesses the person may see (approvers, requester, manager). */
export function useRecordAccessRequests(scope: AccessRequestScope = 'pending', enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'requests', scope],
    enabled,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<AccessRequestRow[]> => {
      if (!supabase) {
        const u = me()
        const manager = !u || u.role === 'manager'
        const rows = sampleRequests.map((r) => ({
          ...r,
          mine: r.requestedById === u?.id,
          canAnswer:
            r.kind === 'request' &&
            r.status === 'pending' &&
            r.visitOpen &&
            r.requestedById !== u?.id &&
            (manager || sampleMayAnswer()),
          canCancel: r.kind === 'request' && r.status === 'pending' && r.requestedById === u?.id,
          canReview: r.kind === 'emergency' && !r.reviewedAt && manager,
        }))
        const visible = rows.filter((r) => r.mine || manager || sampleMayAnswer())
        if (scope === 'pending') return visible.filter((r) => r.canAnswer)
        if (scope === 'mine') return visible.filter((r) => r.mine)
        if (scope === 'emergency') return visible.filter((r) => r.kind === 'emergency')
        return visible
      }
      const { data, error } = await supabase.rpc('record_access_requests', { p_scope: scope })
      if (error) {
        if (isMissingFunction(error)) return []
        throw apiError(error)
      }
      return (data as AccessRequestRow[]) ?? []
    },
  })
}

/** The manager's "Record access" page: who opened past records, filtered. */
export function useRecordAccessLog(f: AccessLogFilter = {}, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'log', f],
    enabled,
    refetchInterval: 60_000,
    queryFn: async (): Promise<AccessLogPage> => {
      if (!supabase) {
        const rows = sampleLog.filter(
          (r) =>
            (!f.patientId || r.patientId === f.patientId) &&
            (!f.actorId || r.actorId === f.actorId) &&
            (!f.via || r.via === f.via) &&
            (!f.from || r.at >= f.from) &&
            (!f.to || r.at < f.to),
        )
        return {
          total: rows.length,
          rows: rows.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 100)),
          unreviewed: sampleRequests.filter((r) => r.kind === 'emergency' && !r.reviewedAt).length,
        }
      }
      const { data, error } = await supabase.rpc('record_access_log', {
        p_from: f.from ?? null,
        p_to: f.to ?? null,
        p_patient_id: f.patientId ?? null,
        p_actor: f.actorId ?? null,
        p_via: f.via ?? null,
        p_limit: f.limit ?? 100,
        p_offset: f.offset ?? 0,
      })
      if (error) {
        if (isMissingFunction(error)) return { total: 0, rows: [], unreviewed: 0 }
        throw apiError(error)
      }
      return data as AccessLogPage
    },
  })
}

/** "Who looked" on the patient file (the manager and the heads in charge: access.canSeeLog). */
export function usePatientAccessLog(patientId: string, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'patientLog', patientId],
    enabled: enabled && !!patientId,
    queryFn: async (): Promise<AccessLogRow[]> => {
      if (!supabase) return sampleLog.filter((r) => r.patientId === patientId)
      const { data, error } = await supabase.rpc('patient_access_log', {
        p_patient_id: patientId,
        p_limit: 50,
      })
      if (error) {
        if (isMissingFunction(error)) return []
        throw apiError(error)
      }
      return (data as AccessLogRow[]) ?? []
    },
  })
}

// ---------------------------------------------------------------- acting
export interface RequestAccessResult {
  id: string
  status: AccessRequestStatus
  /** A request was already waiting for this visit: that one is returned. */
  existing?: boolean
  /** How many people were told (managers and heads in charge). */
  approvers?: number
  /** Emergency: 'emergency'. */
  via?: 'emergency'
}

/**
 * request: ask the manager and the heads in charge (reason required);
 * emergency: open at once (reason required; the manager reviews it);
 * answer: approve, or refuse with a reason (the first approver wins);
 * cancel: withdraw my request still waiting;
 * review: the manager marks an emergency access reviewed, with a comment.
 * Refusals come as ApiError with kind notTreating, notApprover, reasonNeeded, alreadyAnswered,
 * alreadyAllowed or visitClosed.
 */
export function useRecordAccessActions() {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: KEY })
    void qc.invalidateQueries({ queryKey: ['patients'] })
    // the visit record and its track (['visit', id, 'clinical' | 'journey'])
    void qc.invalidateQueries({ queryKey: ['visit'] })
    void qc.invalidateQueries({ queryKey: ['notifications'] })
  }
  const sampleNew = (
    patientId: string,
    encounterId: string,
    kind: AccessRequestKind,
    reason: string,
  ): AccessRequestRow => {
    const u = me()
    const [patient, fileNumber] = samplePatientName[patientId] ?? ['Patient', null]
    const now = new Date().toISOString()
    return {
      id: `ar-${Date.now()}`,
      kind,
      status: kind === 'emergency' ? 'approved' : 'pending',
      patientId,
      patient,
      fileNumber,
      encounterId,
      visitReference: null,
      visitOpen: true,
      requestedById: u?.id ?? 'u-doc',
      requestedBy: u?.name ?? 'Dr. Mukamana Béatrice',
      requestedByRole: u?.role ?? 'doctor',
      reason: reason.trim(),
      at: now,
      answeredBy: null,
      answeredAt: kind === 'emergency' ? now : null,
      answerNote: null,
      active: kind === 'emergency',
      mine: true,
      canAnswer: false,
      canCancel: kind === 'request',
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null,
      canReview: false,
    }
  }
  const checkSample = (i: { patientId: string; encounterId: string | null; reason: string }) => {
    if (!i.encounterId) throw sampleRefusal('notTreating', '42501')
    if (i.reason.trim().length < 3) throw sampleRefusal('reasonNeeded', '22023')
    return i.encounterId
  }
  const request = useMutation({
    mutationFn: async (i: {
      patientId: string
      /** The visit treated now (access.treatingEncounterId); used in sample mode. */
      encounterId: string | null
      reason: string
    }): Promise<RequestAccessResult> => {
      if (!supabase) {
        const enc = checkSample(i)
        const row = sampleNew(i.patientId, enc, 'request', i.reason)
        sampleRequests = [row, ...sampleRequests]
        return { id: row.id, status: row.status, existing: false, approvers: 2 }
      }
      const { data, error } = await supabase.rpc('request_record_access', {
        p_patient_id: i.patientId,
        p_reason: i.reason.trim(),
      })
      if (error) throw apiError(error)
      return data as RequestAccessResult
    },
    onSuccess: refresh,
  })
  const emergency = useMutation({
    mutationFn: async (i: {
      patientId: string
      encounterId: string | null
      reason: string
    }): Promise<RequestAccessResult> => {
      if (!supabase) {
        const enc = checkSample(i)
        const row = sampleNew(i.patientId, enc, 'emergency', i.reason)
        sampleRequests = [row, ...sampleRequests]
        sampleLog = [
          {
            id: `al-${Date.now()}`,
            at: row.at,
            actorId: row.requestedById,
            actor: row.requestedBy,
            actorRole: row.requestedByRole,
            patientId: row.patientId,
            patient: row.patient,
            fileNumber: row.fileNumber,
            encounterId: null,
            visitReference: null,
            via: 'emergency',
            what: 'emergency',
            requestId: row.id,
            reason: row.reason,
            emergency: true,
            reviewed: false,
            reviewedBy: null,
            reviewNote: null,
          },
          ...sampleLog,
        ]
        return { id: row.id, status: 'approved', via: 'emergency' }
      }
      const { data, error } = await supabase.rpc('emergency_record_access', {
        p_patient_id: i.patientId,
        p_reason: i.reason.trim(),
      })
      if (error) throw apiError(error)
      return data as RequestAccessResult
    },
    onSuccess: refresh,
  })
  const answer = useMutation({
    mutationFn: async (i: {
      requestId: string
      approve: boolean
      /** Required to refuse. */
      note?: string
    }): Promise<{ id: string; status: AccessRequestStatus }> => {
      const note = i.note?.trim() || null
      if (!supabase) {
        const r = sampleRequests.find((x) => x.id === i.requestId)
        if (!r) throw sampleRefusal('notFound', 'P0002')
        if (r.status !== 'pending') throw sampleRefusal('alreadyAnswered', '22023')
        if (!i.approve && (!note || note.length < 3)) throw sampleRefusal('reasonNeeded', '22023')
        const status: AccessRequestStatus = i.approve ? 'approved' : 'refused'
        sampleRequests = sampleRequests.map((x) =>
          x.id === i.requestId
            ? {
                ...x,
                status,
                answeredBy: me()?.name ?? 'Mugabo Théogène',
                answeredAt: new Date().toISOString(),
                answerNote: note,
                active: i.approve && x.visitOpen,
              }
            : x,
        )
        return { id: i.requestId, status }
      }
      const { data, error } = await supabase.rpc('answer_record_access', {
        p_request_id: i.requestId,
        p_approve: i.approve,
        p_note: note,
      })
      if (error) throw apiError(error)
      return data as { id: string; status: AccessRequestStatus }
    },
    onSuccess: refresh,
  })
  const cancel = useMutation({
    mutationFn: async (requestId: string) => {
      if (!supabase) {
        sampleRequests = sampleRequests.map((x) =>
          x.id === requestId && x.status === 'pending'
            ? { ...x, status: 'cancelled', answeredAt: new Date().toISOString() }
            : x,
        )
        return
      }
      const { error } = await supabase.rpc('cancel_record_access', { p_request_id: requestId })
      if (error) throw apiError(error)
    },
    onSuccess: refresh,
  })
  const review = useMutation({
    mutationFn: async (i: { requestId: string; note?: string }) => {
      const note = i.note?.trim() || null
      if (!supabase) {
        const u = me()
        if (u && u.role !== 'manager') throw sampleRefusal('notPermitted', '42501')
        const by = u?.name ?? 'Mugabo Théogène'
        const at = new Date().toISOString()
        sampleRequests = sampleRequests.map((x) =>
          x.id === i.requestId
            ? { ...x, reviewedBy: by, reviewedAt: at, reviewNote: note, canReview: false }
            : x,
        )
        sampleLog = sampleLog.map((x) =>
          x.requestId === i.requestId
            ? { ...x, reviewed: true, reviewedBy: by, reviewNote: note }
            : x,
        )
        return
      }
      const { error } = await supabase.rpc('review_emergency_access', {
        p_request_id: i.requestId,
        p_note: note,
      })
      if (error) throw apiError(error)
    },
    onSuccess: refresh,
  })
  return { request, emergency, answer, cancel, review }
}
