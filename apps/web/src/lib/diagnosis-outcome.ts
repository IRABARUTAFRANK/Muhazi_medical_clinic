import type { Tone } from '@mmc/shared'

/**
 * 0192: what the doctor decided about a possible diagnosis (step 3). Never worked out from the
 * words: only from what was saved.
 *   confirmed      a standing definitive diagnosis points at it (the doctor ticked it in step 5,
 *                  or pressed the older Confirm of step 3);
 *   not_confirmed  the doctor saved step 5 with it unticked (who and when are kept);
 *   not_decided    nobody saved step 5 for it yet.
 */
export type DxOutcome = 'confirmed' | 'not_confirmed' | 'not_decided'

/** Each state's colour on screen: confirmed green, not confirmed grey, not decided orange. */
export const OUTCOME_TONE: Record<DxOutcome, Tone> = {
  confirmed: 'green',
  not_confirmed: 'grey',
  not_decided: 'orange',
}

/** A possible diagnosis as the readers carry it (visit_clinical, patient_file, the samples). */
export interface OutcomeSource {
  id?: string
  notConfirmedAt?: string | null
  notConfirmed?: boolean
}
/** A diagnosis of the same visit that may confirm it (a definitive one points at it). */
export interface OutcomeLink {
  differentialId?: string | null
  removedAt?: string | null
}

/** The definitive diagnosis that confirms a possible one (its id), if it still stands. */
export function confirmedLink<T extends OutcomeLink>(
  d: OutcomeSource,
  all: readonly T[],
): T | undefined {
  if (!d.id) return undefined
  return all.find((x) => !x.removedAt && !!x.differentialId && x.differentialId === d.id)
}

/** Confirmed, not confirmed or not decided: from the link and the doctor's saved mark only. */
export function outcomeOf(d: OutcomeSource, all: readonly OutcomeLink[]): DxOutcome {
  if (confirmedLink(d, all)) return 'confirmed'
  if (d.notConfirmedAt || d.notConfirmed) return 'not_confirmed'
  return 'not_decided'
}

/**
 * The words of a diagnosis compared the way the database compares them (trimmed, single
 * spaces, lower case): only to say "it is in the list above: tick it instead", never to decide.
 */
export const dxKey = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase()

/** The words of a typed diagnosis as they are saved: trimmed, single spaces. */
export const dxWords = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * A step-5 save as the database takes it (save_definitive_diagnoses): each possible diagnosis
 * once (its first place kept), the typed words cleaned, empty ones dropped, each spelling once.
 */
export function cleanDefinitiveSave<
  T extends { confirm: string[]; notConfirmed: string[]; other: string[] },
>(i: T): T {
  const once = (ids: string[]) => [...new Set(ids.filter(Boolean))]
  const seen = new Set<string>()
  const other: string[] = []
  for (const raw of i.other) {
    const words = dxWords(raw)
    if (!words || seen.has(dxKey(words))) continue
    seen.add(dxKey(words))
    other.push(words)
  }
  return { ...i, confirm: once(i.confirm), notConfirmed: once(i.notConfirmed), other }
}
