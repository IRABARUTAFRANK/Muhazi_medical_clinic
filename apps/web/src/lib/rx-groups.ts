import type { MyPrescription, RxState } from '@/lib/api/doctor'

/**
 * 0209: "My prescriptions" by patient (Frank, 2026-11-27): one row per patient, opened as their
 * file of prescriptions — each visit's medicines together (a patient seen twice in the period has
 * two prescriptions), newest first. Pure: the page filters and pages the groups.
 */

/** The medicines written on one visit: one prescription. */
export interface RxVisitGroup {
  encounterId: string
  /** When its first medicine was written. */
  at: string
  /** When its last medicine was written (the list is newest first by this). */
  last: string
  visitOpen: boolean
  lines: MyPrescription[]
}

/** A patient's prescriptions of the period. */
export interface RxPatientGroup {
  patientId: string
  patient: string
  fileNumber: string
  /** The newest medicine written for this patient. */
  last: string
  /** Newest first. */
  visits: RxVisitGroup[]
  /** How many medicines in each state (a cancelled line counts as not given). */
  states: Record<RxState, number>
  medicines: number
}

const STATES: readonly RxState[] = ['waiting', 'given', 'not_given', 'room', 'outside']
const later = (a: string, b: string) => (a > b ? a : b)

export function groupByPatient(rows: readonly MyPrescription[]): RxPatientGroup[] {
  const byPatient = new Map<string, RxPatientGroup>()
  const byVisit = new Map<string, RxVisitGroup>()
  for (const r of rows) {
    // a row without a patient id (never expected) still gets its own group
    const pid = r.patientId || `file:${r.fileNumber || r.patient}`
    let p = byPatient.get(pid)
    if (!p) {
      p = {
        patientId: r.patientId,
        patient: r.patient,
        fileNumber: r.fileNumber,
        last: r.at,
        visits: [],
        states: Object.fromEntries(STATES.map((s) => [s, 0])) as Record<RxState, number>,
        medicines: 0,
      }
      byPatient.set(pid, p)
    }
    p.last = later(p.last, r.at)
    p.states[r.state] = (p.states[r.state] ?? 0) + 1
    p.medicines += 1
    const vkey = `${pid}|${r.encounterId}`
    let v = byVisit.get(vkey)
    if (!v) {
      v = { encounterId: r.encounterId, at: r.at, last: r.at, visitOpen: r.visitOpen, lines: [] }
      byVisit.set(vkey, v)
      p.visits.push(v)
    }
    if (r.at < v.at) v.at = r.at
    v.last = later(v.last, r.at)
    v.visitOpen = v.visitOpen || r.visitOpen
    v.lines.push(r)
  }
  const out = [...byPatient.values()]
  for (const p of out) {
    p.visits.sort((a, b) => b.last.localeCompare(a.last))
    for (const v of p.visits) v.lines.sort((a, b) => a.at.localeCompare(b.at))
  }
  return out.sort((a, b) => b.last.localeCompare(a.last))
}

/** The states a group has, in the tab order, with their counts (for the small chips of a row). */
export const statesOf = (g: RxPatientGroup): { state: RxState; count: number }[] =>
  STATES.filter((s) => g.states[s] > 0).map((s) => ({ state: s, count: g.states[s] }))
