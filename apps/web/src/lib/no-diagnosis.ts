import i18n from '@/i18n'

/**
 * "No diagnosis — <reason>" (0125): a visit finished with no diagnosis found. The database keeps
 * the reason as a kind (no_disease, check_up, results_pending, referred, other) and a note; the
 * reports carry it as the marker `[no-dx:<kind>] <note>` in their diagnosis column, which these
 * helpers turn into words in the reader's language.
 */

const MARKER = /^\[no-dx:([a-z_]+)\]\s?(.*)$/s

/** "No diagnosis — Follow-up / check-up only · BP control". */
export function noDiagnosisText(x: { kind: string; note?: string | null }): string {
  const reason = i18n.t(`noDx.kinds.${x.kind}`, { defaultValue: x.kind })
  const note = x.note?.trim()
  return i18n.t('noDx.line', { reason: note ? `${reason} · ${note}` : reason })
}

/** A diagnosis cell of a report: the marker in words, anything else as it is. */
export function dxText<T extends string | null | undefined>(raw: T): T | string {
  if (!raw) return raw
  const m = MARKER.exec(raw)
  return m ? noDiagnosisText({ kind: m[1]!, note: m[2] || null }) : raw
}
