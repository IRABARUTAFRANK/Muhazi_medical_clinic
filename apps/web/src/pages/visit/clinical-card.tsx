import { useState, type FormEvent, type ReactNode } from 'react'
import { SearchSelect } from '@/components/ui/search-select'
import { EmptyNote } from '@/components/clinical/empty-note'
import {
  CheckCircle2,
  ClipboardList,
  FileText,
  FlaskConical,
  HandHeart,
  Pill,
  Plus,
  Printer,
  Stethoscope,
  Trash2,
  TriangleAlert,
  XCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatRwf, formatTime, type StaffUser, type Tone } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Reveal } from '@/components/ui/reveal'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { medicineRuleText, treatmentName, useTreatments } from '@/lib/api/catalogue'
import {
  allergiesForDoc,
  prescriptionState,
  useClinicalActions,
  useItems,
  useVisitClinical,
  type DocPerson,
  type Item,
  type Prescription,
  type PrescriptionState,
  type RxWarning,
} from '@/lib/api/patients'
import { isRoomStore, useStockActions, useStockOverview } from '@/lib/api/stock'
import { useHoldsStore, useStoreStock, type MyStore } from '@/lib/api/rooms'
import { ApiError, errorKind } from '@/lib/api/errors'
import { TestFilesChip } from '@/components/clinical/supporting-files'
import { registrationText, useMyCredentials } from '@/lib/api/staff'
import { stationFor, type Station } from '@/lib/api/visits'
import { buildPrescriptionHtml, type RxDoc, type RxDocMedicine } from '@/lib/prescription-doc'
import { roleLabel } from '@/lib/roles'
import { cn } from '@/lib/utils'
import { useCan, useSwitchedOff } from '@/lib/api/permissions'
import { NotAllowedNotice } from '@/components/clinical/perm-gate'
import {
  deskOfRequest,
  STATION_DESKS,
  TREATING_DESKS,
  useCanDesk,
  useMyDesks,
} from '@/lib/api/desks'
import { openMedicalReport, type ReportMedicine } from '@/lib/medical-report'
import { useLetterhead, useMedicalReportLabels } from '@/lib/report-parts'
import { useConfirm } from '@/lib/confirm'

const errorBox =
  'bg-red-bg text-red m-0 border border-red/30 rounded-md px-3 py-2 text-[13px] font-semibold'
const ROUTES = ['oral', 'IV', 'IM', 'SC', 'topical', 'rectal', 'inhaled', 'other']
/** Standard prescription frequencies (stored as the usual code: OD, BD, TDS…). */
const FREQUENCIES = ['OD', 'BD', 'TDS', 'QID', 'Q8H', 'Q6H', 'NOCTE', 'PRN', 'STAT'] as const
interface RxLine {
  /** Stable key: a line saved before a refusal leaves the form, the others stay. */
  key: number
  item: string
  quantity: string
  dose: string
  route: string
  frequency: string
  days: string
  instructions: string
  /** Patient collects it at the pharmacy, or the prescriber gives it here from the room. */
  supply: 'pharmacy' | 'room'
  /** Given here: the room store chosen ('' = the prescriber's own), and its name. */
  store: string
  storeName: string
}
let lineKey = 0
const emptyLine = (): RxLine => ({
  key: ++lineKey,
  item: '',
  quantity: '',
  dose: '',
  route: 'oral',
  frequency: '',
  days: '',
  instructions: '',
  supply: 'pharmacy',
  store: '',
  storeName: '',
})
/** How a prescription line shows: waiting at the pharmacy, given, not given, cancelled… */
const STATE_TONE: Record<PrescriptionState, Tone> = {
  waiting: 'yellow',
  given: 'green',
  room: 'blue',
  notGiven: 'red',
  returned: 'grey',
  cancelled: 'grey',
}
const STATE_LABEL: Record<PrescriptionState, string> = {
  waiting: 'clinical.toDispense',
  given: 'clinical.dispensed',
  room: 'clinical.givenHere',
  notGiven: 'clinical.notGiven',
  returned: 'clinical.returnedBadge',
  cancelled: 'clinical.cancelled',
}
/** A medicine given here: the room store it came from, when the database says it (optional). */
const givenFrom = (r: Prescription) =>
  (r as Prescription & { givenFrom?: string | null; store?: string | null }).givenFrom ??
  (r as Prescription & { store?: string | null }).store ??
  null
const when = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`

/**
 * The clinical record of a visit, for clinicians (doctor, nurse, manager): allergies banner,
 * complaint / examination notes, diagnoses (primary required to close), prescriptions
 * (queue the patient at the pharmacy), lab and imaging orders (charged and queued), close.
 */
export function ClinicalCard({
  encounterId,
  user,
  closed = false,
  station,
  patient,
  report,
  openReport = false,
  lockedNote = null,
  holder = null,
  patientId = null,
  onDone,
  onError,
}: {
  encounterId: string
  /** The patient (the attachments of each test: 0089). */
  patientId?: string | null
  user: StaffUser
  /** The desk this person works at for this patient (tests send the patient back here). */
  station?: Station
  /** For the printed prescription. */
  patient?: { name: string; fileNumber: string; ageSex: string; weight?: string | null }
  /** For the medical report: the visit's vital signs and what was charged. */
  report?: {
    /** Latest value of each vital sign; the code and unit let the report build its table. */
    vitals: { label: string; value: string; code?: string | null; unit?: string | null }[]
    /** Who measured the latest vital signs, and when (ISO). */
    vitalsBy?: string | null
    vitalsAt?: string | null
    treatments: string[]
    since?: string
  }
  /** Open the medical report panel at once. */
  openReport?: boolean
  /** The patient is with someone else: read only, with who holds them. */
  lockedNote?: string | null
  /** Who holds the patient now (visit_access): the colleague who took them over after a
   *  hand-over may cancel the prescriber's medicine still waiting at the pharmacy (0091). */
  holder?: string | null
  /** A finished visit: shown read-only (everything stays in the patient file). */
  closed?: boolean
  onDone: (m: string) => void
  onError: (m: string | null) => void
}) {
  const { t, i18n } = useTranslation()
  const { data, error, refetch } = useVisitClinical(encounterId)
  const actions = useClinicalActions(encounterId)
  const { data: items = [] } = useItems()
  const { data: treatments = [] } = useTreatments(true)
  // Orderable treatments, grouped by the desk that carries them out.
  const tests = treatments.filter((x) => x.orderStation)
  const desks = [...new Set(tests.map((x) => x.orderStation!))]
  const can = useCan(user)
  const switchedOff = useSwitchedOff(user)
  const stock = useStockActions()
  const readOnly = closed || !!lockedNote
  // The desks a department of the person gives (or, where no department gives one, the role):
  // the clinical record is a treating desk's (Consultation, Dental, Nursing…), results are the
  // laboratory's or the ultrasound's, a hand-over taken back is the pharmacy's.
  const canDesk = useCanDesk(user)
  const clinician = canDesk(TREATING_DESKS) && !readOnly && can('clinical.write')
  // The lab / ultrasound may register the tests of their own desk (a patient who came straight
  // to them); notes, diagnoses and prescriptions stay with the clinicians.
  const deskStaff =
    !clinician && canDesk(['laboratory', 'ultrasound']) && !readOnly && can('orders.write')
  // a doctor or nurse locked out of this patient does not write results on it
  const lockedOut = !!lockedNote && (user.role === 'doctor' || user.role === 'nurse')
  const { data: deskInfo } = useMyDesks(user)
  /** Whose result is it: the laboratory or ultrasound desk of the test; a test done at another
   *  desk (Nursing, Dental…) also that desk's clinical staff; the clinician's own test while no
   *  department gives its desk ('mine' from visit_clinical; before 0085: anyone who orders tests).
   *  As the database checks. */
  const mayResult = (o: { station?: string | null; category: 'lab' | 'imaging' }) =>
    // the laboratory / ultrasound desk comes with the department, the switch with the manager
    (canDesk(deskOfRequest(o.station, o.category)) && can('orders.write')) ||
    (can('clinical.write') &&
      !['laboratory', 'ultrasound'].includes(o.station ?? 'laboratory') &&
      canDesk(STATION_DESKS[o.station ?? ''] ?? [])) ||
    (can('orders.write') &&
      (!!deskInfo?.fallback ||
        ((o as { mine?: boolean }).mine === true &&
          !(deskInfo?.offered ?? []).includes(deskOfRequest(o.station, o.category)))))
  const canResult = (o: Parameters<typeof mayResult>[0]) => !closed && !lockedOut && mayResult(o)
  // A verified result is corrected with a reason, also after the visit ended.
  const canCorrect = (o: Parameters<typeof mayResult>[0]) =>
    user.role === 'manager' || (!lockedOut && mayResult(o))
  const [resultFor, setResultFor] = useState<string | null>(null)
  const [result, setResult] = useState({
    findings: '',
    impression: '',
    verify: true,
    correction: null as string | null,
  })
  const [mode, setMode] = useState<'note' | 'dx' | 'rx' | 'test' | null>(null)

  // small forms
  const [note, setNote] = useState('')
  const [dx, setDx] = useState({
    text: '',
    icd10: '',
    type: 'primary' as 'primary' | 'secondary',
    provisional: false,
  })
  const [rx, setRx] = useState<RxLine[]>([emptyLine()])
  // the same medicine written twice: said once, kept on the second press
  const [twiceOk, setTwiceOk] = useState('')
  const setLine = (i: number, patch: Partial<RxLine>) =>
    setRx((lines) => lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const [order, setOrder] = useState({
    services: [] as string[],
    reason: '',
    send: true,
    urgent: false,
  })
  const [localError, setLocalError] = useState<string | null>(null)
  const confirm = useConfirm()
  const name = patient?.name || t('confirm.visit.thisPatient')
  const isManager = user.role === 'manager'
  // "Given here" is for the people who hold a room store; the manager may give from any one.
  const holds = useHoldsStore()
  const myStores = holds.stores.filter((s) => s.active !== false)
  const canGiveHere = isManager || myStores.length > 0
  const ownStore = myStores.find((s) => s.personal) ?? myStores[0] ?? null
  /** The room store a line given here comes out of: the one chosen, else my own. */
  const storeOf = (l: RxLine) =>
    l.store
      ? { id: l.store, name: l.storeName }
      : ownStore
        ? { id: ownStore.id, name: ownStore.name }
        : null
  // a line the room store refused (not enough, not held): "for the pharmacy" is offered
  const [refused, setRefused] = useState<{ key: number; message: string } | null>(null)
  // prescribing-rule notes from the last prescription (never a refusal)
  const [warnings, setWarnings] = useState<{ item: string; w: RxWarning }[]>([])
  // cancelling a line waiting at the pharmacy, taking a handed-over one back, or putting a
  // medicine given here back in the room store: the reason
  const [reasonFor, setReasonFor] = useState<{
    id: string
    kind: 'cancel' | 'return' | 'undo'
  } | null>(null)
  const [reason, setReason] = useState('')
  const supplies: RxLine['supply'][] = canGiveHere ? ['pharmacy', 'room'] : ['pharmacy']

  const letterhead = useLetterhead()
  const reportLabels = useMedicalReportLabels()
  const [reporting, setReporting] = useState(openReport)
  const [comment, setComment] = useState('')
  // the signed-in person's specialty and council registration (nulls before 0084)
  const { data: creds } = useMyCredentials(user.id)
  const [printingRx, setPrintingRx] = useState(false)
  // every medicine still standing was given here: the patient has nothing to take to a pharmacy
  const allGivenHere =
    !!data &&
    data.prescriptions.some((r) => !r.cancelledAt) &&
    data.prescriptions.every((r) => r.cancelledAt || r.supply === 'room')
  /** A staff member as a document names them: specialty (else role), council registration. */
  const docPerson = (p: DocPerson) => ({
    name: p.name,
    title: p.specialty?.trim() || t(`staff.roles.${p.role}`, { defaultValue: p.role }),
    registrationNo: registrationText(p),
  })
  /** The person printing, as author or prescriber. */
  const me = {
    name: user.name,
    title: creds?.specialty?.trim() || roleLabel(user, t),
    registrationNo: registrationText(creds),
  }
  const routeWords = (r: Prescription) =>
    r.route ? t(`clinical.routes.${r.route}`, { defaultValue: r.route }) : null
  const frequencyWords = (r: Prescription) =>
    r.frequency ? t(`clinical.frequencies.${r.frequency}`, { defaultValue: r.frequency }) : null
  const primaryDx = () =>
    data ? (data.diagnoses.find((d) => d.type === 'primary') ?? data.diagnoses[0]) : undefined

  const printReport = () => {
    if (!data || !patient) return
    const ats = [
      ...[...data.notes, ...data.diagnoses, ...data.prescriptions, ...data.orders].map((x) => x.at),
      ...(report?.since ? [report.since] : []),
    ]
    const first = ats.sort()[0]
    const visitAt = data.visit?.at ?? first ?? null
    const p = data.patient
    const medicines: ReportMedicine[] = data.prescriptions
      // a cancelled line was never taken: it is not part of the record of care
      .filter((r) => !r.cancelledAt)
      .map((r) => {
        const state = prescriptionState(r)
        const route = routeWords(r)
        const frequency = frequencyWords(r)
        const duration = r.days ? t('clinical.forDays', { count: r.days }) : null
        return {
          name: r.item,
          how: [r.dose, route, frequency, duration, r.instructions].filter(Boolean).join(' · '),
          dose: r.dose,
          route,
          frequency,
          duration,
          quantity: r.quantity,
          status: state === 'room' ? 'given' : state === 'returned' ? 'stopped' : 'new',
        }
      })
    const ok = openMedicalReport(
      {
        kind: 'visit',
        clinic: letterhead,
        patient: {
          name: patient.name,
          fileNumber: patient.fileNumber,
          ageSex: patient.ageSex,
          birthDate: p?.birthDate ?? null,
          sex: p?.sex ? t(`register.sexes.${p.sex}`) : null,
          phone: p?.phone ?? null,
          insurer: p?.insurer ?? null,
          memberNo: p?.memberNo ?? null,
          weightKg: p?.weightKg ?? patient.weight ?? null,
          allergies: allergiesForDoc(p),
          bloodGroup: p?.bloodGroup ?? null,
        },
        visits: [
          {
            date: formatDate(visitAt ? new Date(visitAt) : new Date()),
            at: visitAt,
            reference: data.visit?.reference ?? null,
            department: data.visit?.department ?? null,
            referredBy: data.visit?.referredBy ?? null,
            doctor: data.diagnoses[0]?.by ?? data.notes[0]?.by ?? null,
            vitals: report?.vitals ?? [],
            vitalsBy: report?.vitalsBy ?? null,
            vitalsAt: report?.vitalsAt ?? null,
            notes: data.notes.map((n) => n.text),
            diagnoses: data.diagnoses.map((d) => ({
              text: d.text,
              icd10: d.icd10,
              primary: d.type === 'primary',
              provisional: d.provisional,
            })),
            tests: data.orders.map((o) => ({
              name: o.test,
              findings: o.result?.findings ?? null,
              impression: o.result?.impression ?? null,
              verified: !!o.result?.verified,
            })),
            treatments: report?.treatments ?? [],
            medicines,
          },
        ],
        comment: comment.trim() || null,
        author: me,
        printedBy: user.name,
      },
      reportLabels,
    )
    if (!ok) setLocalError(t('report.popupBlocked'))
  }

  const printRx = async () => {
    if (!data || !patient || printingRx) return
    setLocalError(null)
    // the window opens on the click itself (a browser blocks one opened after a wait)
    const w = window.open('', '_blank')
    if (!w) return setLocalError(t('report.popupBlocked'))
    setPrintingRx(true)
    try {
      // the prescription's own number: the same while no line was added (null before 0084)
      const rx = await actions.prescriptionNumber.mutateAsync()
      // a line written at another desk since the last refresh
      let lines = data.prescriptions
      if (rx && rx.lineIds.some((id) => !lines.some((r) => r.id === id)))
        lines = (await refetch()).data?.prescriptions ?? lines
      const covered = lines.filter((r) => !r.cancelledAt && (!rx || rx.lineIds.includes(r.id)))
      const toDoc = (r: Prescription): RxDocMedicine => ({
        name: r.item,
        quantity: r.quantity,
        // codes: the prescription writes them out in plain words
        dose: r.dose,
        route: r.route,
        frequency: r.frequency,
        days: r.days,
        instructions: r.instructions,
      })
      const forPharmacy = covered.filter((r) => r.supply !== 'room')
      const dx = primaryDx()
      const p = data.patient
      // the clinician who wrote it, not whoever prints it
      const writer = rx?.prescriber ?? forPharmacy.find((r) => r.prescriber)?.prescriber ?? null
      const by = forPharmacy[0]?.by
      const prescriber = writer
        ? docPerson(writer)
        : by && by !== user.name
          ? { name: by, title: t('staff.roles.doctor') }
          : me
      const doc: RxDoc = {
        // before 0084 the document makes RX-{file no.}-{date and time} of this one
        number:
          rx?.number ??
          `${patient.fileNumber}-${(forPharmacy[0]?.at ?? new Date().toISOString()).slice(0, 10).replace(/-/g, '')}`,
        date: rx ? new Date(rx.issuedAt) : new Date(),
        clinic: letterhead,
        patient: {
          name: patient.name,
          fileNumber: patient.fileNumber,
          ageSex: patient.ageSex,
          birthDate: p?.birthDate ?? null,
          sex: p?.sex ?? null,
          weight: p?.weightKg ?? patient.weight ?? null,
          allergies: allergiesForDoc(p),
          phone: p?.phone ?? null,
          insurer: p?.insurer ?? null,
          memberNo: p?.memberNo ?? null,
        },
        diagnosis: dx ? { text: dx.text, icd10: dx.icd10, provisional: dx.provisional } : null,
        medicines: forPharmacy.map(toDoc),
        givenHere: covered.filter((r) => r.supply === 'room').map(toDoc),
        prescriber,
        printedBy: user.name,
      }
      w.document.open()
      w.document.write(buildPrescriptionHtml(doc))
      w.document.close()
    } catch (e) {
      w.close()
      setLocalError(
        e instanceof ApiError && e.hint === 'no_lines'
          ? t('rxDoc.noLines')
          : e instanceof Error
            ? e.message
            : String(e),
      )
    } finally {
      setPrintingRx(false)
    }
  }

  const run = async (fn: () => Promise<unknown>, done: string | (() => string)) => {
    setLocalError(null)
    onError(null)
    try {
      await fn()
      setMode(null)
      onDone(typeof done === 'function' ? done() : done)
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e))
    }
  }
  const submitNote = async (e: FormEvent) => {
    e.preventDefault()
    if (!note.trim()) return
    if (
      !(await confirm({
        title: t('confirm.visit.note', { name }),
        body: t('confirm.visit.recordBody'),
        confirmLabel: t('confirm.visit.saveYes'),
      }))
    )
      return
    void run(
      () => actions.addNote.mutateAsync(note).then(() => setNote('')),
      t('clinical.noteSaved'),
    )
  }
  const submitDx = async (e: FormEvent) => {
    e.preventDefault()
    if (!dx.text.trim()) return
    if (
      !(await confirm({
        title: t('confirm.visit.dx', { dx: dx.text.trim(), name }),
        body: t('confirm.visit.recordBody'),
        confirmLabel: t('confirm.visit.saveYes'),
      }))
    )
      return
    void run(
      () =>
        actions.addDiagnosis
          .mutateAsync(dx)
          .then(() => setDx({ text: '', icd10: '', type: 'secondary', provisional: false })),
      t('clinical.dxSaved'),
    )
  }
  const submitRx = async (e: FormEvent) => {
    e.preventDefault()
    const lines = rx.filter((l) => l.item || l.quantity)
    if (lines.length === 0) return setLocalError(t('clinical.errors.rx'))
    const prepared: { item: Item; line: RxLine; q: number }[] = []
    for (const line of lines) {
      const item = items.find((i) => i.id === line.item)
      const q = Number(line.quantity)
      if (!item || !Number.isFinite(q) || q <= 0) return setLocalError(t('clinical.errors.rx'))
      prepared.push({ item, line, q })
    }
    const ids = prepared.map((p) => p.item.id)
    const twice = [
      ...new Set(
        prepared
          .filter((p, i) => ids.indexOf(p.item.id) !== i)
          .map((p) => `${p.item.name} ${p.item.strength ?? ''}`.trim()),
      ),
    ]
    if (twice.length > 0 && twiceOk !== ids.join(',')) {
      setTwiceOk(ids.join(','))
      return setLocalError(t('clinical.errors.rxTwice', { names: twice.join(', ') }))
    }
    // the manager holds no store of their own: they say which room store it comes from
    if (prepared.some((p) => p.line.supply === 'room' && !storeOf(p.line)))
      return setLocalError(t('clinical.errors.pickStore'))
    const list = prepared
      .map((p) => {
        const label = `${[p.item.name, p.item.strength].filter(Boolean).join(' ')} × ${p.q}`
        return p.line.supply === 'room'
          ? `${label} (${t('clinical.fromStore', { store: storeOf(p.line)?.name ?? '' })})`
          : label
      })
      .join(', ')
    if (
      !(await confirm({
        title: t('confirm.visit.rx', { name }),
        body: t('confirm.visit.rxBody', { list }),
        confirmLabel: t('confirm.visit.rxYes'),
      }))
    )
      return
    setLocalError(null)
    onError(null)
    setRefused(null)
    setWarnings([])
    // medicines given here without a price are said; the rule notes are kept on screen
    const unpriced: string[] = []
    const found: { item: string; w: RxWarning }[] = []
    const saved: number[] = []
    let pharmacy = 0
    let here = 0
    const at = { line: null as RxLine | null }
    try {
      // One prescription per medicine, in the order written; the pharmacy sees them together.
      for (const { item, line, q } of prepared) {
        at.line = line
        const r = await actions.prescribe.mutateAsync({
          item,
          quantity: q,
          dose: line.dose,
          route: line.route,
          frequency: line.frequency,
          days: line.days ? Number(line.days) : undefined,
          instructions: line.instructions,
          supply: line.supply,
          station: stationFor(user),
          locationId: line.supply === 'room' ? (storeOf(line)?.id ?? null) : null,
        })
        saved.push(line.key)
        if (line.supply === 'room') {
          here += 1
          if (!r.charged) unpriced.push(item.name)
        } else pharmacy += 1
        const label = [item.name, item.strength].filter(Boolean).join(' ')
        for (const w of r.warnings) found.push({ item: label, w })
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // the lines already saved leave the form; the refused one and the rest stay
      setRx((lines) => {
        const left = lines.filter((l) => !saved.includes(l.key))
        return left.length ? left : [emptyLine()]
      })
      setWarnings(found)
      const kind = errorKind(e)
      if (
        at.line?.supply === 'room' &&
        (kind === 'roomShort' || kind === 'noRoomStore' || kind === 'notHolder')
      )
        setRefused({ key: at.line.key, message })
      else setLocalError(message)
      if (saved.length) onDone(t('clinical.rxPartSaved', { count: saved.length }))
      return
    }
    setRx([emptyLine()])
    setTwiceOk('')
    setMode(null)
    setWarnings(found)
    onDone(
      [
        pharmacy ? t('clinical.rxSaved', { count: pharmacy }) : '',
        here ? t('clinical.rxGivenHere', { count: here }) : '',
        unpriced.length ? t('clinical.roomUnpriced', { names: unpriced.join(', ') }) : '',
      ]
        .filter(Boolean)
        .join(' '),
    )
  }
  /** Cancel a line still waiting at the pharmacy, or take a handed-over one back. */
  const submitReason = async (r: Prescription) => {
    const why = reason.trim()
    if (!reasonFor || why.length < 3) return setLocalError(t('clinical.errors.reason'))
    if (reasonFor.kind === 'cancel') {
      if (
        !(await confirm({
          title: t('confirm.visit.cancelRx', { item: r.item, name }),
          body: t('confirm.visit.cancelRxBody', { reason: why }),
          confirmLabel: t('confirm.visit.cancelRxYes'),
          tone: 'danger',
        }))
      )
        return
      void run(
        () =>
          actions.cancelPrescription.mutateAsync({ requestId: r.id, reason: why }).then((d) => {
            setReasonFor(null)
            setReason('')
            return d
          }),
        t('clinical.rxCancelled', { item: r.item }),
      )
      return
    }
    if (reasonFor.kind === 'undo') {
      if (
        !(await confirm({
          title: t('confirm.visit.undoHere', { item: r.item, name }),
          body: t(closed ? 'confirm.visit.undoHereClosedBody' : 'confirm.visit.undoHereOpenBody', {
            reason: why,
          }),
          confirmLabel: t('confirm.visit.undoHereYes'),
          tone: 'danger',
        }))
      )
        return
      let undone = t('clinical.undone', { item: r.item })
      void run(
        () =>
          actions.undoGivenHere.mutateAsync({ requestId: r.id, reason: why }).then((d) => {
            setReasonFor(null)
            setReason('')
            if (d.mode === 'credit' && d.credit > 0)
              undone = t('clinical.undoneCredit', { item: r.item, amount: formatRwf(d.credit) })
            return d
          }),
        () => undone,
      )
      return
    }
    if (
      !(await confirm({
        title: t('confirm.visit.returnMedicine', { item: r.item, name }),
        body: t(closed ? 'confirm.visit.returnClosedBody' : 'confirm.visit.returnOpenBody', {
          reason: why,
        }),
        confirmLabel: t('confirm.visit.returnMedicineYes'),
        tone: 'danger',
      }))
    )
      return
    let back = t('clinical.returned', { item: r.item })
    void run(
      () =>
        stock.returnMedicine.mutateAsync({ requestId: r.id, reason: why }).then((d) => {
          setReasonFor(null)
          setReason('')
          // the bill was already closed: a credit note, the money goes back at the cashier
          if (d.mode === 'credit')
            back =
              d.credit > 0
                ? t('clinical.returnedCredit', { item: r.item, amount: formatRwf(d.credit) })
                : t('clinical.returnedCreditNone', { item: r.item })
          return d
        }),
      () => back,
    )
  }
  const submitOrder = async (e: FormEvent) => {
    e.preventDefault()
    const chosen = tests.filter((x) => order.services.includes(x.id))
    if (chosen.length === 0) return setLocalError(t('clinical.errors.test'))
    const list = chosen.map((s) => treatmentName(s, i18n.language)).join(', ')
    if (
      !(await confirm({
        title: t('confirm.visit.tests', { name }),
        body: t(
          order.send && !deskStaff ? 'confirm.visit.testsSendBody' : 'confirm.visit.testsBody',
          { list },
        ),
        confirmLabel: t('confirm.visit.testsYes'),
      }))
    )
      return
    void run(
      () =>
        actions.orderTests
          .mutateAsync({
            tests: chosen.map((s) => ({ serviceId: s.id, name: s.nameEn, group: s.group })),
            reason: order.reason,
            // the lab registering its own test: the patient is already there
            from: order.send && !deskStaff ? (station ?? stationFor(user)) : null,
            urgent: order.urgent,
          })
          .then(() => setOrder({ services: [], reason: '', send: true, urgent: false })),
      t(order.send ? 'clinical.testsSent' : 'clinical.testsSaved', { count: chosen.length }),
    )
  }
  const toggleTest = (id: string) =>
    setOrder((o) => ({
      ...o,
      services: o.services.includes(id) ? o.services.filter((x) => x !== id) : [...o.services, id],
    }))
  const finish = async () => {
    if (!data?.diagnoses.some((d) => d.type === 'primary'))
      return setLocalError(t('clinical.errors.needPrimary'))
    if (
      !(await confirm({
        title: t('confirm.visit.finish', { name }),
        body: t('confirm.visit.finishBody'),
        confirmLabel: t('confirm.visit.finishYes'),
      }))
    )
      return
    void run(() => actions.finishVisit.mutateAsync(), t('clinical.finished'))
  }

  // A clinician without the right to request tests (a nurse, by default) is told why the button
  // is greyed and where treatments given here go.
  const noTests = clinician && !can('orders.write')
  const tabBtn = (k: NonNullable<typeof mode>, label: string, icon: React.ReactNode) => {
    const btn = (
      <Button
        size="sm"
        variant={mode === k ? 'primary' : 'default'}
        onClick={() => setMode(mode === k ? null : k)}
        disabled={k === 'test' ? !((clinician || deskStaff) && can('orders.write')) : !clinician}
      >
        {icon}
        {label}
      </Button>
    )
    // a greyed button takes no pointer: the explanation sits on its wrapper
    return k === 'test' && noTests ? (
      <span title={t('clinical.testsWhoTitle')} className="inline-flex">
        {btn}
      </span>
    ) : (
      btn
    )
  }

  return (
    <Card>
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          <Stethoscope size={16} aria-hidden="true" />
          {t('clinical.title')}
        </span>
        <span className="inline-flex flex-wrap items-center gap-2">
          {data?.patient?.bloodGroup && (
            <Badge tone="grey" dot={false}>
              {t('file.fields.blood_group')} {data.patient.bloodGroup}
            </Badge>
          )}
          {patient && data && (
            <Button
              size="sm"
              variant={reporting ? 'primary' : 'default'}
              onClick={() => setReporting((r) => !r)}
              title={t('medReport.hint')}
            >
              <FileText size={14} aria-hidden="true" />
              {t('medReport.open')}
            </Button>
          )}
          {patient && data?.prescriptions.some((r) => !r.cancelledAt) && (
            // every medicine given here: nothing would print for a pharmacy (a greyed button
            // takes no pointer: the explanation sits on its wrapper)
            <span
              title={t(allGivenHere ? 'rxDoc.allGivenHere' : 'rxDoc.printHint')}
              className="inline-flex"
            >
              <Button
                size="sm"
                onClick={() => void printRx()}
                disabled={printingRx || allGivenHere}
              >
                <Printer size={14} aria-hidden="true" />
                {t('rxDoc.print')}
              </Button>
            </span>
          )}
        </span>
      </CardHeader>
      {/* the record is the manager's switch: said, not silently read only */}
      {!readOnly && canDesk(TREATING_DESKS) && switchedOff('clinical.write') && (
        <CardBody>
          <NotAllowedNotice feature="clinical.write" compact />
        </CardBody>
      )}
      {reporting && patient && data && (
        <CardBody className="bg-primary-tint/40 border-border anim-enter gap-2 border-b">
          <p className="m-0 text-[14px] font-semibold">{t('medReport.panelTitle')}</p>
          <p className="text-ink-2 m-0 text-[13px]">{t('medReport.panelLead')}</p>
          <label className="text-ink-2 flex flex-col gap-1.5 text-[13px] font-semibold">
            {t('medReport.commentLabel')}
            <textarea
              rows={3}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={t('medReport.commentPh')}
              className="border-border bg-card text-ink focus:border-primary rounded-md border px-3 py-2 text-[14px] font-normal outline-none"
            />
          </label>
          <span className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={printReport}>
              <Printer size={16} aria-hidden="true" />
              {t('medReport.print')}
            </Button>
            <Button variant="ghost" onClick={() => setReporting(false)}>
              {t('common.close')}
            </Button>
          </span>
        </CardBody>
      )}
      {data?.patient?.allergies && (
        <CardBody className="bg-red-bg text-red border-border border-b py-2 text-[13px] font-semibold">
          ⚠ {t('file.allergiesLabel')}: {data.patient.allergies}
        </CardBody>
      )}
      <CardBody className="gap-3">
        {error && <p className={errorBox}>{error.message}</p>}
        {closed && (
          <p className="bg-green-bg text-green border-green/30 m-0 rounded-md border px-3 py-2 text-[13px] font-semibold">
            {t('clinical.closedNote')}
          </p>
        )}
        {lockedNote && !closed && (
          <p className="bg-violet-bg text-violet border-violet/30 m-0 rounded-md border px-3 py-2 text-[13px] font-semibold">
            {lockedNote}
          </p>
        )}
        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            {tabBtn('note', t('clinical.addNote'), <ClipboardList size={14} aria-hidden="true" />)}
            {tabBtn('dx', t('clinical.addDx'), <Stethoscope size={14} aria-hidden="true" />)}
            {tabBtn('rx', t('clinical.addRx'), <Pill size={14} aria-hidden="true" />)}
            {tabBtn('test', t('clinical.addTest'), <FlaskConical size={14} aria-hidden="true" />)}
          </div>
        )}
        {!clinician && !readOnly && (
          <p className="text-ink-3 m-0 text-xs">{t('clinical.readOnly')}</p>
        )}
        {noTests && <p className="text-ink-3 m-0 text-xs">{t('clinical.testsWhoHint')}</p>}

        {mode === 'note' && (
          <Reveal focus block="nearest">
            <form onSubmit={submitNote} className="flex flex-col gap-2">
              <label className="text-ink-2 flex flex-col gap-1.5 text-[13px] font-semibold">
                {t('clinical.note')}
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={4}
                  placeholder={t('clinical.notePh')}
                  className="border-border bg-card text-ink focus:border-primary focus:ring-primary-tint rounded-md border px-3 py-2 text-[14px] font-normal outline-none focus:ring-[3px]"
                  required
                />
              </label>
              <Button
                type="submit"
                variant="primary"
                className="self-start"
                loading={actions.addNote.isPending}
              >
                {t('clinical.saveNote')}
              </Button>
            </form>
          </Reveal>
        )}
        {mode === 'dx' && (
          <Reveal focus block="nearest">
            <form
              onSubmit={submitDx}
              className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr_1fr_auto]"
            >
              <p className="text-ink-3 col-span-full m-0 text-xs">{t('clinical.dxHint')}</p>
              <Field
                label={t('clinical.dx')}
                value={dx.text}
                onChange={(e) => setDx({ ...dx, text: e.target.value })}
                placeholder={t('clinical.dxPh')}
                required
              />
              <Field
                label="ICD-10"
                value={dx.icd10}
                onChange={(e) => setDx({ ...dx, icd10: e.target.value.toUpperCase() })}
                placeholder="B54"
              />
              <Select
                label={t('clinical.dxType')}
                value={dx.type}
                onChange={(e) => setDx({ ...dx, type: e.target.value as 'primary' | 'secondary' })}
              >
                <option value="primary">{t('clinical.type.primary')}</option>
                <option value="secondary">{t('clinical.type.secondary')}</option>
              </Select>
              <div className="flex items-end gap-2">
                <label className="flex min-h-9 items-center gap-2 text-[13px] font-semibold">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={dx.provisional}
                    onChange={(e) => setDx({ ...dx, provisional: e.target.checked })}
                  />
                  {t('clinical.provisional')}
                </label>
                <Button type="submit" variant="primary" loading={actions.addDiagnosis.isPending}>
                  {t('clinical.saveDx')}
                </Button>
              </div>
              <ul className="text-ink-3 col-span-full m-0 flex flex-col gap-0.5 pl-4 text-xs">
                <li>{t('clinical.icdHint')}</li>
                <li>{t('clinical.provisionalHint')}</li>
              </ul>
            </form>
          </Reveal>
        )}
        {mode === 'rx' && (
          <Reveal focus block="nearest">
            <form onSubmit={submitRx} className="flex flex-col gap-3">
              <p className="text-ink-3 m-0 text-xs">{t('clinical.rxHint')}</p>
              <p className="text-ink-3 m-0 text-xs">
                {t(canGiveHere ? 'clinical.rxPayHint' : 'clinical.rxPharmacyOnly')}
              </p>
              {rx.map((line, i) => (
                <fieldset
                  key={i}
                  className="border-border bg-hover/40 m-0 flex min-w-0 flex-col gap-3 rounded-md border p-3"
                >
                  <legend className="text-ink-2 px-1 text-xs font-semibold">
                    {t('clinical.medicineN', { n: i + 1 })}
                  </legend>
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <SearchSelect
                      label={t('clinical.medicine')}
                      value={line.item}
                      onChange={(v) => setLine(i, { item: v })}
                      wrapperClassName="col-span-2"
                      required
                      emptyLabel={t('clinical.pickMedicine')}
                      options={items.map((it) => ({
                        value: it.id,
                        label: [it.name, it.strength, it.form ? `· ${it.form}` : null]
                          .filter(Boolean)
                          .join(' '),
                      }))}
                    />
                    <Field
                      label={t('clinical.quantity')}
                      inputMode="numeric"
                      value={line.quantity}
                      onChange={(e) =>
                        setLine(i, { quantity: e.target.value.replace(/[^\d]/g, '') })
                      }
                      required
                    />
                    <Field
                      label={t('clinical.days')}
                      inputMode="numeric"
                      value={line.days}
                      onChange={(e) => setLine(i, { days: e.target.value.replace(/[^\d]/g, '') })}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <Field
                      label={t('clinical.dose')}
                      value={line.dose}
                      onChange={(e) => setLine(i, { dose: e.target.value })}
                      placeholder="1 tab"
                    />
                    <Select
                      label={t('clinical.route')}
                      value={line.route}
                      onChange={(e) => setLine(i, { route: e.target.value })}
                    >
                      {ROUTES.map((r) => (
                        <option key={r} value={r}>
                          {t(`clinical.routes.${r}`, { defaultValue: r })}
                        </option>
                      ))}
                    </Select>
                    <Select
                      label={t('clinical.frequency')}
                      value={line.frequency}
                      onChange={(e) => setLine(i, { frequency: e.target.value })}
                    >
                      <option value="">{t('clinical.pickFrequency')}</option>
                      {FREQUENCIES.map((f) => (
                        <option key={f} value={f}>
                          {t(`clinical.frequencies.${f}`)}
                        </option>
                      ))}
                    </Select>
                    <Field
                      label={t('clinical.instructions')}
                      value={line.instructions}
                      onChange={(e) => setLine(i, { instructions: e.target.value })}
                      placeholder={t('clinical.instructionsPh')}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <div className="flex flex-wrap items-center gap-2" role="radiogroup">
                      <span className="text-ink-2 text-[13px] font-semibold">
                        {t('clinical.supplyLabel')}
                      </span>
                      {supplies.map((k) => (
                        <button
                          key={k}
                          type="button"
                          role="radio"
                          aria-checked={line.supply === k}
                          onClick={() => {
                            setLine(i, { supply: k })
                            if (refused?.key === line.key) setRefused(null)
                          }}
                          className={cn(
                            'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold',
                            line.supply === k
                              ? 'border-primary bg-primary text-white'
                              : 'border-border bg-card text-ink-2 hover:bg-hover',
                          )}
                        >
                          {k === 'pharmacy' ? (
                            <Pill size={14} aria-hidden="true" />
                          ) : (
                            <HandHeart size={14} aria-hidden="true" />
                          )}
                          {t(`clinical.supply.${k}`)}
                        </button>
                      ))}
                    </div>
                    {rx.length > 1 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto"
                        onClick={() => setRx((lines) => lines.filter((_, j) => j !== i))}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                        {t('clinical.removeMedicine')}
                      </Button>
                    )}
                  </div>
                  {line.supply === 'room' &&
                    canGiveHere &&
                    (isManager ? (
                      <ManagerRoomStore
                        value={storeOf(line)?.id ?? ''}
                        onChange={(id, storeName) => setLine(i, { store: id, storeName })}
                        itemId={line.item}
                        quantity={Number(line.quantity) || 0}
                        onPharmacy={() => setLine(i, { supply: 'pharmacy' })}
                      />
                    ) : (
                      <RoomStoreChoice
                        stores={myStores}
                        value={storeOf(line)?.id ?? ''}
                        onChange={(id, storeName) => setLine(i, { store: id, storeName })}
                        itemId={line.item}
                        quantity={Number(line.quantity) || 0}
                        onPharmacy={() => setLine(i, { supply: 'pharmacy' })}
                      />
                    ))}
                  {refused?.key === line.key && (
                    <div
                      role="alert"
                      className="bg-red-bg text-red flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-[13px] font-semibold"
                    >
                      <span className="min-w-0 flex-1">{refused.message}</span>
                      <Button
                        size="sm"
                        onClick={() => {
                          setLine(i, { supply: 'pharmacy' })
                          setRefused(null)
                        }}
                      >
                        <Pill size={14} aria-hidden="true" />
                        {t('clinical.switchToPharmacy')}
                      </Button>
                    </div>
                  )}
                </fieldset>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setRx((lines) => [...lines, emptyLine()])}>
                  <Plus size={16} aria-hidden="true" />
                  {t('clinical.addMedicine')}
                </Button>
                <Button type="submit" variant="primary" loading={actions.prescribe.isPending}>
                  <Pill size={16} aria-hidden="true" />
                  {t('clinical.saveRx', { count: rx.filter((l) => l.item).length || 1 })}
                </Button>
              </div>
            </form>
          </Reveal>
        )}
        {mode === 'test' && (
          <Reveal block="nearest">
            <form onSubmit={submitOrder} className="flex flex-col gap-3">
              <p className="text-ink-3 m-0 text-xs">{t('clinical.testHint')}</p>
              {desks
                .filter((g) => !deskStaff || clinician || g === station)
                .map((g) => {
                  const list = tests.filter((s) => s.orderStation === g)
                  if (list.length === 0) return null
                  return (
                    <fieldset key={g} className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
                      <legend className="text-ink-2 mb-1 text-[13px] font-semibold">
                        {t(`register.stations.${g}`, { defaultValue: g })}
                      </legend>
                      <div className="flex flex-wrap gap-2">
                        {list.map((s) => {
                          const on = order.services.includes(s.id)
                          return (
                            <button
                              key={s.id}
                              type="button"
                              role="checkbox"
                              aria-checked={on}
                              onClick={() => toggleTest(s.id)}
                              className={cn(
                                'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold',
                                on
                                  ? 'border-primary bg-primary text-white'
                                  : 'border-border bg-card text-ink-2 hover:bg-hover',
                              )}
                            >
                              {on ? (
                                <CheckCircle2 size={14} aria-hidden="true" />
                              ) : (
                                <FlaskConical size={14} aria-hidden="true" />
                              )}
                              {treatmentName(s, i18n.language)}
                            </button>
                          )
                        })}
                      </div>
                    </fieldset>
                  )
                })}
              {tests.length === 0 && <EmptyNote>{t('clinical.noTests')}</EmptyNote>}
              <Field
                label={t('clinical.reason')}
                value={order.reason}
                onChange={(e) => setOrder({ ...order, reason: e.target.value })}
                placeholder={t('clinical.reasonPh')}
              />
              <label className="flex min-h-9 items-center gap-2 text-[13px] font-semibold">
                <input
                  type="checkbox"
                  className="accent-primary size-[18px]"
                  checked={order.send}
                  onChange={(e) => setOrder({ ...order, send: e.target.checked })}
                />
                {t('clinical.sendNow')}
              </label>
              <label className="flex items-center gap-2 text-[13px] font-semibold">
                <input
                  type="checkbox"
                  className="accent-red size-[18px]"
                  checked={order.urgent}
                  onChange={(e) => setOrder({ ...order, urgent: e.target.checked })}
                />
                {t('clinical.urgentOrder')}
              </label>
              <Button
                type="submit"
                variant="primary"
                className="self-start"
                disabled={order.services.length === 0}
                loading={actions.orderTests.isPending}
              >
                <FlaskConical size={16} aria-hidden="true" />
                {t('clinical.saveTests', { count: order.services.length || 1 })}
              </Button>
            </form>
          </Reveal>
        )}
        {localError && (
          <p role="alert" className={errorBox}>
            {localError}
          </p>
        )}
        {warnings.length > 0 && (
          <div
            role="status"
            className="bg-amber-bg text-amber flex flex-col gap-1 rounded-md px-3 py-2 text-[13px]"
          >
            <span className="flex items-center gap-2 font-semibold">
              <TriangleAlert size={14} aria-hidden="true" />
              {t('clinical.rxWarn.title')}
            </span>
            <ul className="m-0 flex flex-col gap-0.5 pl-5">
              {warnings.map(({ item, w }, i) => (
                <li key={i}>
                  {t('clinical.rxWarn.line', {
                    item,
                    rule: w.rule ? medicineRuleText(w.rule, t) : '',
                  })}
                  {w.kind === 'prescribingRule' &&
                    ` ${
                      w.specialty
                        ? t('clinical.rxWarn.specialty', { specialty: w.specialty })
                        : t('clinical.rxWarn.noSpecialty')
                    }`}
                </li>
              ))}
            </ul>
            <span className="text-xs">{t('clinical.rxWarn.hint')}</span>
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() => setWarnings([])}
            >
              {t('common.close')}
            </Button>
          </div>
        )}
      </CardBody>

      {/* Record */}
      {data &&
        data.notes.length +
          data.diagnoses.length +
          data.prescriptions.length +
          data.orders.length ===
          0 && (
          <CardBody className="border-border border-t">
            <EmptyNote>{t('clinical.empty')}</EmptyNote>
          </CardBody>
        )}
      {data &&
        data.notes.map((n) => (
          <Row key={n.id} className="items-start gap-3 py-2">
            <Badge tone="grey" dot={false} className="mt-0.5">
              {t('clinical.note')}
            </Badge>
            <span className="min-w-0 flex-1">
              <span className="block whitespace-pre-wrap">{n.text}</span>
              <span className="text-ink-3 block text-xs">
                {[when(n.at), n.by].filter(Boolean).join(' · ')}
              </span>
            </span>
          </Row>
        ))}
      {data &&
        data.diagnoses.map((d) => (
          <Row key={d.id} className="gap-3 py-2">
            <Badge tone={d.type === 'primary' ? 'blue' : 'grey'} dot={false}>
              {t(`clinical.type.${d.type}`)}
            </Badge>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">
                {d.text}
                {d.icd10 && <span className="text-ink-3 ml-2 text-xs">{d.icd10}</span>}
                {d.provisional && (
                  <span className="text-ink-3 ml-2 text-xs">({t('clinical.provisional')})</span>
                )}
              </span>
              <span className="text-ink-3 block text-xs">
                {[when(d.at), d.by].filter(Boolean).join(' · ')}
              </span>
            </span>
          </Row>
        ))}
      {data &&
        data.prescriptions.map((r) => {
          const state = prescriptionState(r)
          // the prescriber (or the manager) withdraws a line still waiting at the pharmacy; so
          // does the colleague who took the patient over (the holder of the visit, as the
          // database checks through the hand-over since 0091)
          const wrote = r.prescriberId ? r.prescriberId === user.id : !!r.by && r.by === user.name
          const tookOver = !readOnly && !wrote && !!holder && holder.split(', ').includes(user.name)
          const canCancel =
            state === 'waiting' &&
            r.pending !== false &&
            !closed &&
            (isManager || wrote || tookOver) &&
            can('clinical.write')
          // the pharmacy undoes a hand-over (wrong medicine, brought back unopened)
          const canReturn = state === 'given' && r.supply !== 'room' && canDesk('pharmacy')
          // a medicine given here by mistake: the one who gave it (the same day) or the manager
          // puts it back in the room store
          const givenToday =
            !!r.givenAt && new Date(r.givenAt).toDateString() === new Date().toDateString()
          const canUndo =
            state === 'room' &&
            !!r.givenAt &&
            (isManager || (wrote && givenToday)) &&
            can('clinical.write')
          const asking = reasonFor?.id === r.id ? reasonFor : null
          const from = givenFrom(r)
          const returnedWhy = (r.notGivenReason ?? '').replace(/^returned:\s*/i, '')
          return (
            <Row key={r.id} className="items-start gap-3 py-2">
              <Badge tone={STATE_TONE[state]} dot={false} className="mt-0.5">
                {t(STATE_LABEL[state])}
              </Badge>
              <span className="min-w-0 flex-1">
                <span
                  className={cn('block font-semibold', state === 'cancelled' && 'line-through')}
                >
                  {r.item} × {r.quantity}
                </span>
                <span className="text-ink-3 block text-xs">
                  {[
                    r.dose,
                    r.route,
                    r.frequency,
                    r.days ? t('clinical.forDays', { count: r.days }) : null,
                    r.instructions,
                    state === 'room' && from ? t('clinical.fromStore', { store: from }) : null,
                    state === 'room' && r.givenBy
                      ? t('clinical.givenBy', { name: r.givenBy })
                      : null,
                    state === 'notGiven' && r.notGivenReason
                      ? t('clinical.notGivenWhy', { reason: r.notGivenReason })
                      : null,
                    state === 'returned'
                      ? t('clinical.returnedWhy', { reason: returnedWhy })
                      : null,
                    state === 'cancelled'
                      ? t('clinical.cancelledWhy', { reason: r.cancelReason ?? '' })
                      : null,
                    state === 'cancelled' ? r.cancelledBy : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {asking && (
                  <Reveal focus block="nearest">
                    <form
                      className="mt-2 flex flex-col gap-2"
                      onSubmit={(e) => {
                        e.preventDefault()
                        void submitReason(r)
                      }}
                    >
                      <Field
                        label={t(
                          asking.kind === 'cancel'
                            ? 'clinical.cancelWhy'
                            : asking.kind === 'undo'
                              ? 'clinical.undoWhy'
                              : 'clinical.returnWhy',
                          { item: r.item },
                        )}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder={t(
                          asking.kind === 'cancel'
                            ? 'clinical.cancelWhyPh'
                            : asking.kind === 'undo'
                              ? 'clinical.undoWhyPh'
                              : 'clinical.returnWhyPh',
                        )}
                        required
                        minLength={3}
                      />
                      <p className="text-ink-3 m-0 text-xs">
                        {t(
                          asking.kind === 'cancel'
                            ? 'clinical.cancelHint'
                            : asking.kind === 'undo'
                              ? closed
                                ? 'clinical.undoClosedHint'
                                : 'clinical.undoOpenHint'
                              : closed
                                ? 'clinical.returnClosedHint'
                                : 'clinical.returnOpenHint',
                        )}
                      </p>
                      <span className="flex flex-wrap gap-2">
                        <Button
                          type="submit"
                          size="sm"
                          variant="danger"
                          loading={
                            asking.kind === 'cancel'
                              ? actions.cancelPrescription.isPending
                              : asking.kind === 'undo'
                                ? actions.undoGivenHere.isPending
                                : stock.returnMedicine.isPending
                          }
                        >
                          {t(
                            asking.kind === 'cancel'
                              ? 'clinical.cancelRx'
                              : asking.kind === 'undo'
                                ? 'clinical.undoHere'
                                : 'clinical.returnMedicine',
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setReasonFor(null)
                            setReason('')
                          }}
                        >
                          {t('staff.form.cancel')}
                        </Button>
                      </span>
                    </form>
                  </Reveal>
                )}
              </span>
              {canCancel && !asking && (
                <Button
                  size="sm"
                  variant="danger"
                  title={t('clinical.cancelRxHint')}
                  onClick={() => {
                    setReasonFor({ id: r.id, kind: 'cancel' })
                    setReason('')
                  }}
                >
                  <XCircle size={14} aria-hidden="true" />
                  {t('clinical.cancelRx')}
                </Button>
              )}
              {canReturn && !asking && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setReasonFor({ id: r.id, kind: 'return' })
                    setReason('')
                  }}
                >
                  {t('clinical.returnMedicine')}
                </Button>
              )}
              {canUndo && !asking && (
                <Button
                  size="sm"
                  variant="ghost"
                  title={t('clinical.undoHereHint')}
                  onClick={() => {
                    setReasonFor({ id: r.id, kind: 'undo' })
                    setReason('')
                  }}
                >
                  {t('clinical.undoHere')}
                </Button>
              )}
            </Row>
          )
        })}
      {data &&
        data.orders.map((o) => (
          <Row key={o.id} className="gap-3 py-2">
            <Badge tone={o.result ? 'green' : 'blue'} dot={false}>
              {o.station
                ? t(`register.stations.${o.station}`, { defaultValue: o.station })
                : o.category === 'imaging'
                  ? t('register.stations.ultrasound')
                  : t('register.stations.laboratory')}
            </Badge>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">
                {o.test}{' '}
                <span className="text-ink-3 text-xs">· {t(`clinical.status.${o.status}`)}</span>
              </span>
              {o.reason && <span className="text-ink-3 block text-xs">{o.reason}</span>}
              {/* the image or printout the laboratory / ultrasound attached to the test */}
              <TestFilesChip
                encounterId={encounterId}
                patientId={patientId}
                serviceRequestId={o.id}
              />
              {o.result && (
                <span className="bg-green-bg/60 mt-1 block rounded-md px-2.5 py-1.5 text-[13px]">
                  {o.result.findings && <span className="block">{o.result.findings}</span>}
                  {o.result.impression && (
                    <span className="block font-semibold">{o.result.impression}</span>
                  )}
                  <span className="text-ink-3 block text-xs">
                    {[
                      o.result.verified ? t('clinical.verified') : t('clinical.notVerified'),
                      o.result.corrected
                        ? t('clinical.correctedWhy', { reason: o.result.correctionReason ?? '' })
                        : null,
                      o.result.by,
                      o.result.at ? when(o.result.at) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              )}
              {resultFor === o.id && (
                <Reveal focus block="nearest">
                  <form
                    className="mt-2 flex flex-col gap-2"
                    onSubmit={async (e) => {
                      e.preventDefault()
                      const correcting = result.correction !== null
                      if (
                        !(await confirm({
                          title: t(
                            correcting
                              ? 'confirm.visit.resultCorrect'
                              : result.verify
                                ? 'confirm.visit.resultVerify'
                                : 'confirm.visit.result',
                            { test: o.test, name },
                          ),
                          body: t(
                            correcting
                              ? 'confirm.visit.resultCorrectBody'
                              : result.verify
                                ? 'confirm.visit.resultVerifyBody'
                                : 'confirm.visit.resultBody',
                          ),
                          confirmLabel: t(
                            correcting ? 'confirm.visit.resultCorrectYes' : 'confirm.visit.saveYes',
                          ),
                        }))
                      )
                        return
                      void run(
                        () =>
                          actions.recordResult
                            .mutateAsync({ requestId: o.id, ...result })
                            .then(() => setResultFor(null)),
                        t('clinical.resultSaved'),
                      )
                    }}
                  >
                    <label className="text-ink-2 flex flex-col gap-1 text-[13px] font-semibold">
                      {t('clinical.findings')}
                      <textarea
                        rows={2}
                        className="border-border bg-card rounded-md border px-2.5 py-2 text-[14px] font-normal"
                        value={result.findings}
                        onChange={(e) => setResult({ ...result, findings: e.target.value })}
                      />
                    </label>
                    <label className="text-ink-2 flex flex-col gap-1 text-[13px] font-semibold">
                      {t('clinical.impression')}
                      <input
                        className="border-border bg-card h-10 rounded-md border px-2.5 text-[14px] font-normal"
                        value={result.impression}
                        onChange={(e) => setResult({ ...result, impression: e.target.value })}
                      />
                    </label>
                    {result.correction === null ? (
                      <label className="flex items-center gap-2 text-[13px] font-semibold">
                        <input
                          type="checkbox"
                          className="accent-primary size-4"
                          checked={result.verify}
                          onChange={(e) => setResult({ ...result, verify: e.target.checked })}
                        />
                        {t('clinical.verifyNow')}
                      </label>
                    ) : (
                      <label className="text-ink-2 flex flex-col gap-1 text-[13px] font-semibold">
                        {t('clinical.correctionWhy')}
                        <input
                          required
                          minLength={3}
                          className="border-border bg-card h-10 rounded-md border px-2.5 text-[14px] font-normal"
                          placeholder={t('clinical.correctionPh')}
                          value={result.correction}
                          onChange={(e) => setResult({ ...result, correction: e.target.value })}
                        />
                      </label>
                    )}
                    <span className="flex gap-2">
                      <Button
                        type="submit"
                        size="sm"
                        variant="primary"
                        loading={actions.recordResult.isPending}
                      >
                        {result.correction === null
                          ? t('clinical.saveResult')
                          : t('clinical.saveCorrection')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setResultFor(null)}
                      >
                        {t('staff.form.cancel')}
                      </Button>
                    </span>
                  </form>
                </Reveal>
              )}
            </span>
            {(o.result?.verified ? canCorrect(o) : canResult(o)) &&
              resultFor !== o.id &&
              o.status !== 'cancelled' && (
                <Button
                  size="sm"
                  onClick={() => {
                    setResultFor(o.id)
                    setResult({
                      findings: o.result?.findings ?? '',
                      impression: o.result?.impression ?? '',
                      verify: true,
                      correction: o.result?.verified ? '' : null,
                    })
                  }}
                >
                  <FlaskConical size={14} aria-hidden="true" />
                  {t(
                    o.result?.verified
                      ? 'clinical.correctResult'
                      : o.result
                        ? 'clinical.editResult'
                        : 'clinical.enterResult',
                  )}
                </Button>
              )}
          </Row>
        ))}

      {clinician && (
        <CardBody className="border-border flex-row flex-wrap items-center gap-3 border-t">
          <Button
            variant="success"
            onClick={() => void finish()}
            loading={actions.finishVisit.isPending}
          >
            <CheckCircle2 size={16} aria-hidden="true" />
            {t('clinical.finish')}
          </Button>
          <span
            className={cn(
              'text-xs',
              data?.diagnoses.some((d) => d.type === 'primary') ? 'text-ink-3' : 'text-red',
            )}
          >
            {t('clinical.finishHint')}
          </span>
        </CardBody>
      )}
    </Card>
  )
}

interface StoreChoiceProps {
  value: string
  onChange: (id: string, name: string) => void
  /** The medicine on this line and how many: the store's stock of it is shown. */
  itemId: string
  quantity: number
  /** Not enough here: the line goes to the pharmacy instead. */
  onPharmacy: () => void
}

/** The manager gives from any open room store: the list comes from the stock overview. */
function ManagerRoomStore(props: StoreChoiceProps) {
  const { data } = useStockOverview()
  const stores = (data?.locations ?? [])
    .filter((l) => isRoomStore(l) && l.active !== false)
    .map((l) => ({ id: l.id, name: l.name }))
  return <RoomStoreChoice {...props} stores={stores} pick />
}

/**
 * Given here: which room store it comes out of (default: my own) and how much of the medicine
 * it holds, never counting expired units. Not enough: "for the pharmacy" is offered.
 */
function RoomStoreChoice({
  stores,
  pick = false,
  value,
  onChange,
  itemId,
  quantity,
  onPharmacy,
}: StoreChoiceProps & {
  stores: Pick<MyStore, 'id' | 'name'>[]
  /** No store is preset (the manager): one must be chosen. */
  pick?: boolean
}) {
  const { t } = useTranslation()
  const known = stores.some((s) => s.id === value)
  const current = known ? value : ''
  const { data, isLoading } = useStoreStock(current || null)
  const storeName = stores.find((s) => s.id === current)?.name ?? ''
  const row = data?.items.find((x) => x.itemId === itemId)
  const usable = row?.usable ?? 0
  let stockLine: ReactNode = null
  if (current && itemId && !isLoading && data) {
    const short = quantity > 0 && usable < quantity
    stockLine = (
      <span
        className={cn(
          'flex flex-wrap items-center gap-2 text-[13px]',
          short ? 'text-red font-semibold' : 'text-ink-2',
        )}
      >
        <span>
          {usable === 0
            ? t('clinical.roomStock.none', { store: storeName })
            : short
              ? t('clinical.roomStock.short', { count: usable, store: storeName, quantity })
              : t('clinical.roomStock.ready', { count: usable, store: storeName })}
          {row && row.expired > 0 && ` ${t('clinical.roomStock.expired', { count: row.expired })}`}
        </span>
        {short && (
          <Button size="sm" onClick={onPharmacy}>
            <Pill size={14} aria-hidden="true" />
            {t('clinical.switchToPharmacy')}
          </Button>
        )}
      </span>
    )
  }
  return (
    <div className="border-border bg-card flex flex-col gap-2 rounded-md border px-3 py-2">
      {stores.length > 1 || pick ? (
        <Select
          label={t('clinical.roomStock.label')}
          value={current}
          onChange={(e) =>
            onChange(e.target.value, stores.find((s) => s.id === e.target.value)?.name ?? '')
          }
          required
        >
          {(pick || !current) && <option value="">{t('clinical.roomStock.pick')}</option>}
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      ) : (
        <span className="text-ink-2 text-[13px] font-semibold">
          {t('clinical.fromStore', { store: storeName || stores[0]?.name || '' })}
        </span>
      )}
      {stores.length === 0 && (
        <span className="text-ink-3 text-xs">{t('clinical.roomStock.noStores')}</span>
      )}
      {stockLine}
    </div>
  )
}
