import i18n from '@/i18n'
import { DB_MESSAGES } from './db-messages.generated'

/**
 * Database refusals turned into clear words for clinic staff (migrations 0082 and 0083).
 *
 * The functions raise a SQLSTATE (errcode) and often a hint word. PostgREST hands both back as
 * `code` and `hint`. Known codes and hints get a translated message (stockErrors.*); any other
 * sentence is looked up in the generated table of the database's sentences (dbErrors.*, see
 * scripts/db-messages.mjs) and only an unknown one keeps the server's own English. The screens
 * can still branch on `code` / `hint` / `kind`, for example MS003 (not enough in the room store)
 * offers "for the pharmacy" instead.
 */

/** The English words the database writes into a sentence (desk names: initcap of the station enum
 *  or a word; a transfer note's status), and the key that says them in the person's language. */
const INSERTED_WORDS: Record<string, string> = {
  Reception: 'register.stations.reception',
  Triage: 'register.stations.triage',
  Consultation: 'register.stations.consultation',
  Doctor: 'register.stations.consultation',
  Dental: 'register.stations.dental',
  Laboratory: 'register.stations.laboratory',
  Lab: 'register.stations.laboratory',
  Ultrasound: 'register.stations.ultrasound',
  Imaging: 'register.stations.ultrasound',
  Theatre: 'register.stations.theatre',
  Nursing: 'register.stations.nursing',
  Pharmacy: 'register.stations.pharmacy',
  Cashier: 'register.stations.cashier',
  Beds: 'register.stations.beds',
  received: 'roomStores.noteStatus.received',
  cancelled: 'roomStores.noteStatus.cancelled',
}

/** The translated sentence for one the database wrote, or null when it is not a known one. */
export function translateDbSentence(sentence: string): string | null {
  for (const [re, key, n] of DB_MESSAGES) {
    const m = re.exec(sentence)
    if (!m) continue
    const params: Record<string, string> = {}
    for (let i = 1; i <= n; i++) {
      const v = m[i] ?? ''
      params[`p${i}`] = INSERTED_WORDS[v] ? i18n.t(INSERTED_WORDS[v]) : v
    }
    return i18n.t(key, { ...params, defaultValue: sentence })
  }
  return null
}

export interface DbErrorLike {
  code?: string | null
  message?: string | null
  hint?: string | null
  details?: string | null
}

/** The translated kinds (the i18n key under stockErrors). */
export type ApiErrorKind =
  | 'noOpenBill'
  | 'doctorHolds'
  | 'roomShort'
  | 'notHolder'
  | 'noRoomStore'
  | 'notRoomStore'
  | 'receiveIntoPharmacy'
  | 'useTransferNote'
  | 'noMainStore'
  | 'batchExpiry'
  | 'expiredDate'
  | 'storeClosed'
  | 'noPrice'
  | 'notPaid'
  | 'differenceReason'
  | 'packSize'
  | 'supplier'
  | 'short'
  | 'shortBy'
  | 'expiredShort'
  | 'ownNote'
  | 'noHolder'
  | 'storeHasStock'
  | 'notesInTransit'
  | 'hasStock'
  | 'duplicateDelivery'
  // 0085: not in a department that does this desk's work
  | 'noDesk'
  // 0087: the manager has switched this work off (Settings → Who may do what)
  | 'notPermitted'
  // 0088: patient record privacy (access requests, emergency access)
  | 'notTreating'
  | 'notApprover'
  | 'reasonNeeded'
  | 'alreadyAnswered'
  | 'alreadyAllowed'
  | 'visitClosed'
  | 'notManager'
  // 0089: supporting files (photos, scans, PDFs on the patient file)
  | 'fileType'
  | 'fileTooBig'
  | 'fileEmpty'
  | 'filePath'
  | 'titleNeeded'
  | 'fileKind'
  | 'fileVisitClosed'
  | 'notOnVisit'
  | 'wrongTest'
  | 'notUploaded'
  | 'privateRecord'
  | 'notUploader'
  | 'removeTooLate'
  | 'alreadyRemoved'
  | 'filesUnavailable'
  | 'sessionExpired'
  | 'storageNotDeleted'
  // 0088: handing a patient over to a colleague; cover retired
  | 'handoverNotHolder'
  | 'handoverNotColleague'
  | 'handoverNote'
  | 'handoverReason'
  | 'handoverPending'
  | 'handoverNotYours'
  | 'handoverGone'
  | 'coverRetired'
  // 0102: vital signs (a value outside the catalogue's limits, a custom one without a name)
  | 'vitalRange'
  | 'vitalName'
  | 'vitalUnknown'
  // sample mode only (the database's own sentence is kept for these)
  | 'alreadyDone'
  | 'notFound'

const BY_CODE: Record<string, ApiErrorKind> = {
  MS001: 'noOpenBill',
  MS002: 'doctorHolds',
  MS003: 'roomShort',
}

const BY_HINT: Record<string, ApiErrorKind> = {
  no_open_bill: 'noOpenBill',
  doctor_holds: 'doctorHolds',
  room_short: 'roomShort',
  not_holder: 'notHolder',
  no_room_store: 'noRoomStore',
  not_room_store: 'notRoomStore',
  receive_into_pharmacy: 'receiveIntoPharmacy',
  use_transfer_note: 'useTransferNote',
  no_main_store: 'noMainStore',
  batch_expiry: 'batchExpiry',
  expired_date: 'expiredDate',
  store_closed: 'storeClosed',
  no_price: 'noPrice',
  not_paid: 'notPaid',
  difference_reason: 'differenceReason',
  pack_size: 'packSize',
  supplier: 'supplier',
  short: 'short',
  expired_short: 'expiredShort',
  own_note: 'ownNote',
  no_holder: 'noHolder',
  store_has_stock: 'storeHasStock',
  notes_in_transit: 'notesInTransit',
  has_stock: 'hasStock',
  duplicate_delivery: 'duplicateDelivery',
  no_desk: 'noDesk',
  not_permitted: 'notPermitted',
  not_treating: 'notTreating',
  not_approver: 'notApprover',
  reason_needed: 'reasonNeeded',
  already_answered: 'alreadyAnswered',
  already_allowed: 'alreadyAllowed',
  visit_closed: 'visitClosed',
  not_manager: 'notManager',
  file_type: 'fileType',
  file_too_big: 'fileTooBig',
  file_path: 'filePath',
  title_needed: 'titleNeeded',
  file_kind: 'fileKind',
  file_visit_closed: 'fileVisitClosed',
  not_on_visit: 'notOnVisit',
  wrong_test: 'wrongTest',
  not_uploaded: 'notUploaded',
  private: 'privateRecord',
  not_uploader: 'notUploader',
  remove_too_late: 'removeTooLate',
  already_removed: 'alreadyRemoved',
  not_found: 'notFound',
  handover_not_holder: 'handoverNotHolder',
  handover_not_colleague: 'handoverNotColleague',
  handover_note: 'handoverNote',
  handover_reason: 'handoverReason',
  handover_pending: 'handoverPending',
  handover_not_yours: 'handoverNotYours',
  handover_gone: 'handoverGone',
  cover_retired: 'coverRetired',
  vital_range: 'vitalRange',
  vital_name: 'vitalName',
  vital_unknown: 'vitalUnknown',
}

/** An error from a database function, with its code and hint kept for the screens. */
export class ApiError extends Error {
  /** SQLSTATE: 42501 not allowed, 22023 bad input, 23514 not enough / not empty, 23505 already
   *  done, P0002 not found, MS001 no open bill, MS002 the doctor holds the patient, MS003 the
   *  room store is short. */
  readonly code: string | null
  readonly hint: string | null
  /** The translated kind, when the code or hint is a known one. */
  readonly kind: ApiErrorKind | null
  /** The delivery line (1, 2…) a receive_delivery refusal is about. */
  readonly line: number | null
  /** The sentence the database wrote (English), for the details. */
  readonly serverMessage: string

  constructor(
    message: string,
    o: {
      code: string | null
      hint: string | null
      kind: ApiErrorKind | null
      line: number | null
      serverMessage: string
    },
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = o.code
    this.hint = o.hint
    this.kind = o.kind
    this.line = o.line
    this.serverMessage = o.serverMessage
  }
}

/** The ApiError for a PostgREST error (or anything thrown). */
export function apiError(e: DbErrorLike | null | undefined): ApiError {
  const code = e?.code ?? null
  const hint = e?.hint ?? null
  const raw = e?.message ?? 'Something went wrong'
  // receive_delivery: "line 3: …" keeps the line's own code and hint
  const m = /^line (\d+): ([\s\S]*)$/.exec(raw)
  const line = m ? Number(m[1]) : null
  const inner = m ? m[2]! : raw
  let kind = (code && BY_CODE[code]) || (hint && BY_HINT[hint]) || null
  // "… 3 unit(s) short": the number missing is kept in the translated sentence
  const short = /(\d+) unit\(s\) short/.exec(inner)
  const n = short ? Number(short[1]) : null
  if (kind === 'short' && n != null) kind = 'shortBy'
  // the database's own sentence in the person's language; a refusal or a missing record without a
  // known sentence still reads in their language, with a general reason
  const known = kind ? null : translateDbSentence(inner)
  const generic =
    !kind && !known && !hint && code === '42501'
      ? i18n.t('apiErrors.notAllowed', { defaultValue: inner })
      : !kind && !known && !hint && code === 'P0002'
        ? i18n.t('apiErrors.notFound', { defaultValue: inner })
        : null
  const text = kind
    ? i18n.t(`stockErrors.${kind}`, { defaultValue: inner, n: n ?? '' })
    : (known ?? generic ?? inner)
  const message = line != null ? i18n.t('stockErrors.line', { n: line, message: text }) : text
  return new ApiError(message, { code, hint, kind, line, serverMessage: raw })
}

/** Throws the ApiError of a PostgREST error, if any. */
export function throwIf(error: DbErrorLike | null | undefined): void {
  if (error) throw apiError(error)
}

/** The database is older than the function (PostgREST: no function with these arguments). */
export const isMissingFunction = (e: DbErrorLike | null | undefined): boolean =>
  !!e &&
  (e.code === 'PGRST202' ||
    /could not find the function|schema cache/i.test(e.message ?? '') ||
    /function .* does not exist/i.test(e.message ?? ''))

/** The kind of a thrown error, when it is a known database refusal. */
export const errorKind = (e: unknown): ApiErrorKind | null =>
  e instanceof ApiError ? e.kind : null

/** A refusal in sample mode, worded like the database's. */
export function sampleRefusal(kind: ApiErrorKind, code: string): ApiError {
  const text = i18n.t(`stockErrors.${kind}`)
  return new ApiError(text, { code, hint: null, kind, line: null, serverMessage: text })
}
