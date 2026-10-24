import i18n from '@/i18n'

/**
 * Database refusals turned into clear words for clinic staff (migrations 0082 and 0083).
 *
 * The functions raise a SQLSTATE (errcode) and often a hint word. PostgREST hands both back as
 * `code` and `hint`. Known codes and hints get a translated message (stockErrors.*); anything else
 * keeps the server's own sentence. The screens can still branch on `code` / `hint` / `kind`, for
 * example MS003 (not enough in the room store) offers "for the pharmacy" instead.
 */

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
  const text = kind ? i18n.t(`stockErrors.${kind}`, { defaultValue: inner, n: n ?? '' }) : inner
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
