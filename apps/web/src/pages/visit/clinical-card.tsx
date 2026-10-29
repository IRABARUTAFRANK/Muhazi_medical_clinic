import { useState, type FormEvent, type ReactNode } from 'react'
import { SearchSelect } from '@/components/ui/search-select'
import { EmptyNote } from '@/components/clinical/empty-note'
import {
  CheckCircle2,
  ClipboardList,
  FileText,
  FlaskConical,
  HandHeart,
  History,
  Pencil,
  Pill,
  Plus,
  Printer,
  Stethoscope,
  Store,
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
import {
  medicineRuleText,
  treatmentName,
  useMedicineReference,
  medicineRefOption,
  sortMedicineRefs,
  useTreatments,
} from '@/lib/api/catalogue'
import {
  allergiesForDoc,
  prescriptionState,
  useClinicalActions,
  useItems,
  useRxStock,
  useVisitClinical,
  type Diagnosis,
  type DocPerson,
  type Item,
  type Prescription,
  type PrescriptionState,
  type RecordVersion,
  type RxSupply,
  type RxWarning,
} from '@/lib/api/patients'
import { VisitEditLock } from '@/components/clinical/visit-edit-lock'
import { useEditWindow } from '@/components/clinical/edit-window'
import { isRoomStore, useStockActions, useStockOverview } from '@/lib/api/stock'
import { useHoldsStore, useStoreStock, type MyStore } from '@/lib/api/rooms'
import { priceQuantity } from '@/lib/pack-pricing'
import { priceLineText, saleModeText, wholePacksText } from '@/pages/stock/stock-util'
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
  deskName,
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
  /** Patient collects it at the pharmacy, the prescriber gives it here from the room, or the
   *  patient buys it at an outside pharmacy (0100: not charged, not at the clinic pharmacy). */
  supply: RxSupply
  /** The prescriber chose who gives it; until then it follows the stock of the medicine picked. */
  supplyChosen: boolean
  /** A medicine the clinic does not hold, written by hand (item = TYPED). */
  typedName: string
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
  supplyChosen: false,
  typedName: '',
  store: '',
  storeName: '',
})
/** The medicine picker's values: a clinic medicine is its id; one only on the official list is
 *  REF + its code; TYPED is a medicine written by hand (both only for an outside pharmacy). */
const REF = 'ref:'
const TYPED = 'typed'
const outsideOnly = (value: string) => value === TYPED || value.startsWith(REF)
/** How a prescription line shows: waiting at the pharmacy, given, not given, cancelled… */
const STATE_TONE: Record<PrescriptionState, Tone> = {
  waiting: 'yellow',
  given: 'green',
  room: 'blue',
  notGiven: 'red',
  returned: 'grey',
  cancelled: 'grey',
  outside: 'orange',
}
const STATE_LABEL: Record<PrescriptionState, string> = {
  waiting: 'clinical.toDispense',
  given: 'clinical.dispensed',
  room: 'clinical.givenHere',
  notGiven: 'clinical.notGiven',
  returned: 'clinical.returnedBadge',
  cancelled: 'clinical.cancelled',
  outside: 'clinical.outsideTag',
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
  // A finished visit is locked (0104): read-only until the person types the e-mailed code, which
  // opens a 30-minute edit window (`editing`); `finished` keeps the wording of a closed bill.
  const lock = data?.editLock ?? null
  const { editing } = useEditWindow(lock)
  const finished = closed || lock?.closed === true || data?.visit?.status === 'closed'
  const locked = finished && !editing
  const readOnly = locked || !!lockedNote
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
   *  desk (Nursing, Dental…) also that desk's clinical staff. Never the clinician who asked for
   *  it (0104: the requester fallback is gone, in the database too). As the database checks. */
  const mayResult = (o: { station?: string | null; category: 'lab' | 'imaging' }) =>
    // the laboratory / ultrasound desk comes with the department, the switch with the manager
    (canDesk(deskOfRequest(o.station, o.category)) && can('orders.write')) ||
    (can('clinical.write') &&
      !['laboratory', 'ultrasound'].includes(o.station ?? 'laboratory') &&
      canDesk(STATION_DESKS[o.station ?? ''] ?? []))
  const canResult = (o: Parameters<typeof mayResult>[0]) => !locked && !lockedOut && mayResult(o)
  /** 0104: the manager (only) is told when no department gives the desk that does a test. */
  const noDeskFor = (o: Parameters<typeof mayResult>[0]): string | null => {
    const desk = deskOfRequest(o.station, o.category)
    if (user.role !== 'manager' || !deskInfo || deskInfo.fallback) return null
    if (!['laboratory', 'ultrasound'].includes(desk)) return null
    return deskInfo.offered.includes(desk) ? null : deskName(desk, t)
  }
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
  // editing or removing a diagnosis, editing a note (0104): the line's form, with the reason
  const [dxEdit, setDxEdit] = useState<{
    id: string
    text: string
    icd10: string
    type: 'primary' | 'secondary'
    provisional: boolean
    reason: string
  } | null>(null)
  const [dxRemove, setDxRemove] = useState<{ id: string; reason: string } | null>(null)
  const [noteEdit, setNoteEdit] = useState<{ id: string; text: string; reason: string } | null>(
    null,
  )
  // the previous versions unfolded, per line
  const [versionsOf, setVersionsOf] = useState<string | null>(null)
  /** The diagnoses still standing (a removed one stays in the record, struck through). */
  const standing = (list: Diagnosis[]) => list.filter((d) => !d.removedAt)
  // the clinic pharmacy's usable stock, and the official list for medicines bought outside
  const { data: rxStock = null } = useRxStock(mode === 'rx')
  const { data: refs = [] } = useMedicineReference(mode === 'rx')

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
  const refOf = (value: string) =>
    value.startsWith(REF) ? refs.find((r) => r.code === value.slice(REF.length)) : undefined
  /** Usable units at the clinic pharmacy (null: not a clinic medicine, or not known). */
  const stockOf = (value: string) =>
    rxStock && items.some((it) => it.id === value) ? (rxStock[value] ?? 0) : null
  /** Choosing the medicine: who gives it follows the stock (enough: the clinic pharmacy; none:
   *  an outside pharmacy) until the prescriber chooses; a medicine the clinic does not hold is
   *  always bought outside. */
  const pickMedicine = (i: number, value: string) =>
    setRx((lines) =>
      lines.map((l, j) => {
        if (j !== i) return l
        if (outsideOnly(value))
          return { ...l, item: value, supply: 'outside' as const, supplyChosen: false }
        const n = stockOf(value)
        const supply: RxSupply = l.supplyChosen
          ? l.supply
          : n == null || n > 0
            ? 'pharmacy'
            : 'outside'
        return { ...l, item: value, supply }
      }),
    )
  /** What the clinic has of the medicine chosen, said under the picker. */
  const stockNote = (l: RxLine): { tone: Tone; text: string } | null => {
    if (outsideOnly(l.item)) return { tone: 'grey', text: t('clinical.stock.notSold') }
    if (!l.item) return null
    const n = stockOf(l.item)
    if (n == null) return null
    if (n <= 0) return { tone: 'red', text: t('clinical.stock.none') }
    if ((Number(l.quantity) || 0) > n)
      return { tone: 'yellow', text: t('clinical.stock.few', { count: n }) }
    return { tone: 'green', text: t('clinical.stock.in', { count: n }) }
  }
  const itemCodes = new Set(items.map((it) => it.code))
  const medicineOptions = [
    { value: TYPED, label: t('clinical.typedMedicine') },
    ...items.map((it) => ({
      value: it.id,
      label: [it.name, it.strength, it.form ? `· ${it.form}` : null].filter(Boolean).join(' '),
    })),
    // the official list's medicines the clinic does not hold: for an outside pharmacy
    ...sortMedicineRefs(refs.filter((r) => !itemCodes.has(r.code))).map((r) => ({
      ...medicineRefOption(r, t, REF + r.code),
      hint: t('clinical.stock.notSold'),
    })),
  ]
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
  const supplies: RxSupply[] = canGiveHere
    ? ['pharmacy', 'room', 'outside']
    : ['pharmacy', 'outside']

  const letterhead = useLetterhead()
  const reportLabels = useMedicalReportLabels()
  const [reporting, setReporting] = useState(openReport)
  const [comment, setComment] = useState('')
  // the signed-in person's specialty and council registration (nulls before 0084)
  const { data: creds } = useMyCredentials(user.id)
  const [printingRx, setPrintingRx] = useState(false)
  // the printed prescription lists only the medicines the patient buys at an outside pharmacy
  // (0104): those given at the clinic pharmacy or here stay on the medical report
  const hasOutside = !!data?.prescriptions.some((r) => !r.cancelledAt && r.supply === 'outside')
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
  const primaryDx = () => {
    const list = data ? standing(data.diagnoses) : []
    return list.find((d) => d.type === 'primary') ?? list[0]
  }

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
            // a removed diagnosis is not part of the record of care
            diagnoses: standing(data.diagnoses).map((d) => ({
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

  /** The prescription: only the medicines the patient buys at an outside pharmacy (0104). */
  const printRx = async () => {
    if (!data || !patient || printingRx || !hasOutside) return
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
      // never a medicine given at the clinic pharmacy or here, not even greyed
      const forPharmacy = covered.filter((r) => r.supply === 'outside')
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
        givenHere: [],
        outside: true,
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
    const prepared: {
      item: Item | null
      name: string
      code: string | null
      line: RxLine
      q: number
    }[] = []
    for (const line of lines) {
      const item = items.find((i) => i.id === line.item) ?? null
      const ref = refOf(line.item)
      const name = item
        ? [item.name, item.strength].filter(Boolean).join(' ')
        : ref
          ? ref.presentation
            ? `${ref.generic} (${ref.presentation})`
            : ref.generic
          : line.item === TYPED
            ? line.typedName.trim()
            : ''
      const q = Number(line.quantity)
      if (!name || !Number.isFinite(q) || q <= 0) return setLocalError(t('clinical.errors.rx'))
      prepared.push({ item, name, code: ref?.code ?? null, line, q })
    }
    const ids = prepared.map((p) => p.item?.id ?? p.code ?? p.name.toLowerCase())
    const twice = [
      ...new Set(prepared.filter((_, i) => ids.indexOf(ids[i]!) !== i).map((p) => p.name)),
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
        const label = `${p.name} × ${p.q}`
        return p.line.supply === 'room'
          ? `${label} (${t('clinical.fromStore', { store: storeOf(p.line)?.name ?? '' })})`
          : p.line.supply === 'outside'
            ? `${label} (${t('clinical.outsideTag')})`
            : label
      })
      .join(', ')
    if (
      !(await confirm({
        title: t('confirm.visit.rx', { name }),
        body: [
          t('confirm.visit.rxBody', { list }),
          prepared.some((p) => p.line.supply === 'outside') ? t('confirm.visit.rxOutsideNote') : '',
        ]
          .filter(Boolean)
          .join(' '),
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
    let outside = 0
    const at = { line: null as RxLine | null }
    try {
      // One prescription per medicine, in the order written; the pharmacy sees them together.
      for (const { item, name: medicineName, code, line, q } of prepared) {
        at.line = line
        const r = await actions.prescribe.mutateAsync({
          item,
          medicineName,
          referenceCode: code,
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
          if (!r.charged) unpriced.push(medicineName)
        } else if (line.supply === 'outside') outside += 1
        else pharmacy += 1
        for (const w of r.warnings) found.push({ item: medicineName, w })
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
        outside ? t('clinical.rxOutsideSaved', { count: outside }) : '',
        unpriced.length ? t('clinical.roomUnpriced', { names: unpriced.join(', ') }) : '',
      ]
        .filter(Boolean)
        .join(' '),
    )
  }
  /** The prescriber sends a line to an outside pharmacy, or back to the clinic pharmacy (0100). */
  const decideSupply = async (r: Prescription, to: 'pharmacy' | 'outside') => {
    const out = to === 'outside'
    if (
      !(await confirm({
        title: t(out ? 'confirm.visit.outside' : 'confirm.visit.clinic', { item: r.item, name }),
        body: t(out ? 'confirm.visit.outsideBody' : 'confirm.visit.clinicBody'),
        confirmLabel: t(out ? 'confirm.visit.outsideYes' : 'confirm.visit.clinicYes'),
      }))
    )
      return
    void run(
      () => actions.setSupply.mutateAsync({ requestId: r.id, supply: to }),
      t(out ? 'clinical.sentOutside' : 'clinical.backToClinic', { item: r.item }),
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
          body: t(
            finished ? 'confirm.visit.undoHereClosedBody' : 'confirm.visit.undoHereOpenBody',
            {
              reason: why,
            },
          ),
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
        body: t(finished ? 'confirm.visit.returnClosedBody' : 'confirm.visit.returnOpenBody', {
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
  /** The author of a line (or the manager) changes or removes it, with a reason (0104). */
  const mayEditLine = (byId: string | null | undefined) =>
    clinician && (isManager || (!!byId && byId === user.id))
  const submitDxEdit = async (e: FormEvent) => {
    e.preventDefault()
    if (!dxEdit) return
    if (dxEdit.reason.trim().length < 3 || !dxEdit.text.trim())
      return setLocalError(t('clinical.errors.reason'))
    if (
      !(await confirm({
        title: t('confirm.visit.editDx', { dx: dxEdit.text.trim(), name }),
        body: t('confirm.visit.editDxBody', { reason: dxEdit.reason.trim() }),
        confirmLabel: t('confirm.visit.changeYes'),
      }))
    )
      return
    void run(
      () => actions.updateDiagnosis.mutateAsync(dxEdit).then(() => setDxEdit(null)),
      t('clinical.dxUpdated'),
    )
  }
  const submitDxRemove = async (d: Diagnosis) => {
    if (!dxRemove || dxRemove.reason.trim().length < 3)
      return setLocalError(t('clinical.errors.reason'))
    if (
      !(await confirm({
        title: t('confirm.visit.removeDx', { dx: d.text, name }),
        body: t('confirm.visit.removeDxBody', { reason: dxRemove.reason.trim() }),
        confirmLabel: t('confirm.visit.removeYes'),
        tone: 'danger',
      }))
    )
      return
    void run(
      () =>
        actions.removeDiagnosis
          .mutateAsync({ id: d.id, reason: dxRemove.reason })
          .then(() => setDxRemove(null)),
      t('clinical.dxRemoved'),
    )
  }
  const submitNoteEdit = async (e: FormEvent) => {
    e.preventDefault()
    if (!noteEdit) return
    if (noteEdit.reason.trim().length < 3 || !noteEdit.text.trim())
      return setLocalError(t('clinical.errors.reason'))
    if (
      !(await confirm({
        title: t('confirm.visit.editNote', { name }),
        body: t('confirm.visit.editDxBody', { reason: noteEdit.reason.trim() }),
        confirmLabel: t('confirm.visit.changeYes'),
      }))
    )
      return
    void run(
      () => actions.updateNote.mutateAsync(noteEdit).then(() => setNoteEdit(null)),
      t('clinical.noteUpdated'),
    )
  }
  /** "edited by … on …" under a changed line, and the fold-out of its previous versions. */
  const editedMark = (
    x: {
      id: string
      editedAt?: string | null
      editedBy?: string | null
      editReason?: string | null
    },
    history: RecordVersion[] | undefined,
  ) => {
    const versions = history ?? []
    if (!x.editedAt && versions.length === 0) return null
    const open = versionsOf === x.id
    return (
      <span className="mt-1 block text-xs">
        {x.editedAt && (
          <span className="text-orange block font-semibold">
            <Pencil size={11} aria-hidden="true" className="mr-1 inline-block align-[-1px]" />
            {t('clinical.editedBy', { name: x.editedBy ?? '', when: when(x.editedAt) })}
            {x.editReason ? ` · ${t('clinical.editedWhy', { reason: x.editReason })}` : ''}
          </span>
        )}
        {versions.length > 0 && (
          <>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setVersionsOf(open ? null : x.id)}
              className="text-primary inline-flex items-center gap-1 bg-transparent p-0 font-semibold hover:underline"
            >
              <History size={12} aria-hidden="true" />
              {t('clinical.previousVersions', { count: versions.length })}
            </button>
            {open && (
              <ul className="border-border bg-surface mt-1 flex flex-col gap-1.5 rounded-md border px-3 py-2 pl-7">
                {versions.map((v, i) => (
                  <li key={i} className="text-ink-2">
                    <span className="text-ink block whitespace-pre-wrap line-through">
                      {[
                        v.text,
                        v.icd10,
                        v.type ? t(`clinical.type.${v.type}`) : null,
                        v.provisional ? t('clinical.provisional') : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    <span className="text-ink-3 block">
                      {[
                        v.since
                          ? t('clinical.versionWrote', {
                              name: v.wroteBy ?? '',
                              when: when(v.since),
                            })
                          : null,
                        t('clinical.versionReplaced', {
                          name: v.replacedBy ?? '',
                          when: when(v.replacedAt),
                          reason: v.reason ?? '',
                        }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </span>
    )
  }
  /** The reason box of an edit or a removal, with its buttons. */
  const reasonField = (
    value: string,
    onChange: (v: string) => void,
    labelKey: string,
    placeholderKey: string,
  ) => (
    <Field
      label={t(labelKey)}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={t(placeholderKey)}
      required
      minLength={3}
    />
  )
  const finish = async () => {
    if (!data || !standing(data.diagnoses).some((d) => d.type === 'primary'))
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
      <CardHeader hue="navy">
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
            // one print: only the medicines bought at an outside pharmacy (0104); every medicine
            // given at the clinic: nothing to print (a greyed button takes no pointer: the
            // explanation sits on its wrapper)
            <span
              title={t(hasOutside ? 'rxDoc.printOutsideOnly' : 'rxDoc.nothingOutside')}
              className="inline-flex"
            >
              <Button size="sm" onClick={() => void printRx()} disabled={printingRx || !hasOutside}>
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
        {/* a finished visit is locked (0104): the code opens a 30-minute edit window */}
        {finished && lock ? (
          <VisitEditLock
            encounterId={encounterId}
            lock={lock}
            patientName={patient?.name}
            onDone={onDone}
            onError={onError}
          />
        ) : (
          finished && (
            <p className="bg-green-bg text-green border-green/30 m-0 rounded-md border px-3 py-2 text-[13px] font-semibold">
              {t('clinical.closedNote')}
            </p>
          )
        )}
        {lockedNote && !finished && (
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
              <p className="text-ink-3 m-0 text-xs">{t('clinical.rxOutsideHint')}</p>
              {rx.map((line, i) => (
                <fieldset
                  key={i}
                  className="border-border bg-hover/40 m-0 flex min-w-0 flex-col gap-3 rounded-md border p-3"
                >
                  <legend className="text-ink-2 px-1 text-xs font-semibold">
                    {t('clinical.medicineN', { n: i + 1 })}
                  </legend>
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <div className="col-span-2 flex min-w-0 flex-col gap-1.5">
                      <SearchSelect
                        label={t('clinical.medicine')}
                        value={line.item}
                        onChange={(v) => pickMedicine(i, v)}
                        required
                        emptyLabel={t('clinical.pickMedicine')}
                        options={medicineOptions}
                        onWrite={(text) => {
                          pickMedicine(i, TYPED)
                          setLine(i, { typedName: text })
                        }}
                        writeLabel={(text) => t('clinical.writeMedicine', { name: text })}
                      />
                      {(() => {
                        const note = stockNote(line)
                        return note ? (
                          <Badge tone={note.tone} className="self-start" aria-live="polite">
                            {note.text}
                          </Badge>
                        ) : null
                      })()}
                      {line.item === TYPED && (
                        <Field
                          label={t('clinical.typedName')}
                          value={line.typedName}
                          onChange={(e) => setLine(i, { typedName: e.target.value })}
                          placeholder={t('clinical.typedNamePh')}
                          required
                        />
                      )}
                    </div>
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
                      {supplies.map((k) => {
                        // a medicine the clinic does not hold: only an outside pharmacy
                        const off = k !== 'outside' && outsideOnly(line.item)
                        return (
                          <button
                            key={k}
                            type="button"
                            role="radio"
                            aria-checked={line.supply === k}
                            disabled={off}
                            title={off ? t('clinical.stock.notSold') : undefined}
                            onClick={() => {
                              setLine(i, { supply: k, supplyChosen: true })
                              if (refused?.key === line.key) setRefused(null)
                            }}
                            className={cn(
                              'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold disabled:cursor-not-allowed disabled:opacity-50',
                              line.supply === k
                                ? k === 'outside'
                                  ? 'border-orange bg-orange text-white'
                                  : 'border-primary bg-primary text-white'
                                : 'border-border bg-card text-ink-2 hover:bg-hover',
                            )}
                          >
                            {k === 'pharmacy' ? (
                              <Pill size={14} aria-hidden="true" />
                            ) : k === 'room' ? (
                              <HandHeart size={14} aria-hidden="true" />
                            ) : (
                              <Store size={14} aria-hidden="true" />
                            )}
                            {t(`clinical.supply.${k}`)}
                          </button>
                        )
                      })}
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
                  {line.supply === 'outside' && (
                    <p className="bg-orange-bg text-orange border-orange/25 m-0 flex items-start gap-2 rounded-md border px-3 py-2 text-[13px] font-semibold">
                      <Store size={14} aria-hidden="true" className="mt-0.5 flex-none" />
                      {t('clinical.outsideLineHint')}
                    </p>
                  )}
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
        data.notes.map((n) => {
          const editingThis = noteEdit?.id === n.id
          return (
            <Row key={n.id} className="flex-wrap items-start gap-3 py-2">
              <Badge tone="grey" dot={false} className="mt-0.5">
                {t('clinical.note')}
              </Badge>
              <span className="min-w-0 flex-[1_1_14rem]">
                {editingThis ? (
                  <Reveal focus block="nearest">
                    <form onSubmit={submitNoteEdit} className="flex flex-col gap-2">
                      <label className="text-ink-2 flex flex-col gap-1.5 text-[13px] font-semibold">
                        {t('clinical.note')}
                        <textarea
                          value={noteEdit.text}
                          onChange={(e) => setNoteEdit({ ...noteEdit, text: e.target.value })}
                          rows={4}
                          required
                          className="border-border bg-card text-ink focus:border-primary rounded-md border px-3 py-2 text-[14px] font-normal outline-none"
                        />
                      </label>
                      {reasonField(
                        noteEdit.reason,
                        (v) => setNoteEdit({ ...noteEdit, reason: v }),
                        'clinical.editWhy',
                        'clinical.editWhyPh',
                      )}
                      <span className="flex flex-wrap gap-2">
                        <Button
                          type="submit"
                          size="sm"
                          variant="primary"
                          loading={actions.updateNote.isPending}
                        >
                          {t('clinical.saveChange')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setNoteEdit(null)}>
                          {t('staff.form.cancel')}
                        </Button>
                      </span>
                    </form>
                  </Reveal>
                ) : (
                  <>
                    <span className="block whitespace-pre-wrap">{n.text}</span>
                    <span className="text-ink-3 block text-xs">
                      {[when(n.at), n.by].filter(Boolean).join(' · ')}
                    </span>
                    {editedMark(n, n.history)}
                  </>
                )}
              </span>
              {!editingThis && mayEditLine(n.byId) && (
                <Button
                  size="sm"
                  variant="ghost"
                  title={t('clinical.editNoteHint')}
                  onClick={() => {
                    setLocalError(null)
                    setNoteEdit({ id: n.id, text: n.text, reason: '' })
                  }}
                >
                  <Pencil size={14} aria-hidden="true" />
                  {t('clinical.editLine')}
                </Button>
              )}
            </Row>
          )
        })}
      {data &&
        data.diagnoses.map((d) => {
          const editingThis = dxEdit?.id === d.id
          const removingThis = dxRemove?.id === d.id
          const removed = !!d.removedAt
          return (
            <Row key={d.id} className="flex-wrap items-start gap-3 py-2">
              <Badge
                tone={removed ? 'grey' : d.type === 'primary' ? 'blue' : 'grey'}
                dot={false}
                className="mt-0.5"
              >
                {t(`clinical.type.${d.type}`)}
              </Badge>
              <span className="min-w-0 flex-[1_1_14rem]">
                {editingThis ? (
                  <Reveal focus block="nearest">
                    <form
                      onSubmit={submitDxEdit}
                      className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr_1fr]"
                    >
                      <Field
                        label={t('clinical.dx')}
                        value={dxEdit.text}
                        onChange={(e) => setDxEdit({ ...dxEdit, text: e.target.value })}
                        required
                      />
                      <Field
                        label="ICD-10"
                        value={dxEdit.icd10}
                        onChange={(e) =>
                          setDxEdit({ ...dxEdit, icd10: e.target.value.toUpperCase() })
                        }
                      />
                      <Select
                        label={t('clinical.dxType')}
                        value={dxEdit.type}
                        onChange={(e) =>
                          setDxEdit({ ...dxEdit, type: e.target.value as 'primary' | 'secondary' })
                        }
                      >
                        <option value="primary">{t('clinical.type.primary')}</option>
                        <option value="secondary">{t('clinical.type.secondary')}</option>
                      </Select>
                      <label className="flex min-h-9 items-center gap-2 text-[13px] font-semibold">
                        <input
                          type="checkbox"
                          className="accent-primary"
                          checked={dxEdit.provisional}
                          onChange={(e) => setDxEdit({ ...dxEdit, provisional: e.target.checked })}
                        />
                        {t('clinical.provisional')}
                      </label>
                      <span className="sm:col-span-2">
                        {reasonField(
                          dxEdit.reason,
                          (v) => setDxEdit({ ...dxEdit, reason: v }),
                          'clinical.editWhy',
                          'clinical.editWhyPh',
                        )}
                      </span>
                      <span className="col-span-full flex flex-wrap gap-2">
                        <Button
                          type="submit"
                          size="sm"
                          variant="primary"
                          loading={actions.updateDiagnosis.isPending}
                        >
                          {t('clinical.saveChange')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDxEdit(null)}>
                          {t('staff.form.cancel')}
                        </Button>
                      </span>
                    </form>
                  </Reveal>
                ) : (
                  <>
                    <span className={cn('block font-semibold', removed && 'line-through')}>
                      {d.text}
                      {d.icd10 && <span className="text-ink-3 ml-2 text-xs">{d.icd10}</span>}
                      {d.provisional && (
                        <span className="text-ink-3 ml-2 text-xs">
                          ({t('clinical.provisional')})
                        </span>
                      )}
                    </span>
                    <span className="text-ink-3 block text-xs">
                      {[when(d.at), d.by].filter(Boolean).join(' · ')}
                    </span>
                    {removed && (
                      <span className="text-red mt-1 block text-xs font-semibold">
                        <XCircle
                          size={11}
                          aria-hidden="true"
                          className="mr-1 inline-block align-[-1px]"
                        />
                        {t('clinical.removedBy', {
                          name: d.removedBy ?? '',
                          when: when(d.removedAt!),
                          reason: d.removeReason ?? '',
                        })}
                      </span>
                    )}
                    {editedMark(d, d.history)}
                    {removingThis && (
                      <Reveal focus block="nearest">
                        <form
                          className="mt-2 flex flex-col gap-2"
                          onSubmit={(e) => {
                            e.preventDefault()
                            void submitDxRemove(d)
                          }}
                        >
                          {reasonField(
                            dxRemove.reason,
                            (v) => setDxRemove({ ...dxRemove, reason: v }),
                            'clinical.removeWhy',
                            'clinical.editWhyPh',
                          )}
                          <p className="text-ink-3 m-0 text-xs">{t('clinical.removeHint')}</p>
                          <span className="flex flex-wrap gap-2">
                            <Button
                              type="submit"
                              size="sm"
                              variant="danger"
                              loading={actions.removeDiagnosis.isPending}
                            >
                              {t('clinical.removeLine')}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setDxRemove(null)}>
                              {t('staff.form.cancel')}
                            </Button>
                          </span>
                        </form>
                      </Reveal>
                    )}
                  </>
                )}
              </span>
              {!removed && !editingThis && !removingThis && mayEditLine(d.byId) && (
                <span className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    title={t('clinical.editDxHint')}
                    onClick={() => {
                      setLocalError(null)
                      setDxEdit({
                        id: d.id,
                        text: d.text,
                        icd10: d.icd10 ?? '',
                        type: d.type,
                        provisional: d.provisional,
                        reason: '',
                      })
                    }}
                  >
                    <Pencil size={14} aria-hidden="true" />
                    {t('clinical.editLine')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    title={t('clinical.removeDxHint')}
                    onClick={() => {
                      setLocalError(null)
                      setDxRemove({ id: d.id, reason: '' })
                    }}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    {t('clinical.removeLine')}
                  </Button>
                </span>
              )}
            </Row>
          )
        })}
      {data &&
        data.prescriptions.map((r) => {
          const state = prescriptionState(r)
          // the prescriber (or the manager) withdraws a line still waiting at the pharmacy; so
          // does the colleague who took the patient over (the holder of the visit, as the
          // database checks through the hand-over since 0091)
          const wrote = r.prescriberId ? r.prescriberId === user.id : !!r.by && r.by === user.name
          const tookOver = !readOnly && !wrote && !!holder && holder.split(', ').includes(user.name)
          const canCancel =
            ((state === 'waiting' && r.pending !== false) || state === 'outside') &&
            !locked &&
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
          // who gives it (0100): the prescriber, the colleague who took the patient over, the
          // manager, or whoever treats the patient now. A line partly handed over sends only its
          // remainder outside, as a new line (0104 rx_set_supply, splitFrom = this line).
          const given = r.quantityGiven ?? 0
          const remaining = r.quantity - given
          const splitChild =
            given > 0
              ? data.prescriptions.find((x) => x.splitFrom === r.id && !x.cancelledAt)
              : undefined
          const mayDecide =
            can('clinical.write') &&
            canDesk(TREATING_DESKS) &&
            (isManager || wrote || tookOver || !readOnly)
          const canOutside =
            mayDecide &&
            !splitChild &&
            (given === 0 || remaining > 0) &&
            ((state === 'waiting' && r.pending !== false) || state === 'notGiven')
          // back to the clinic pharmacy needs the open bill: never once the visit is finished
          const canClinic = mayDecide && state === 'outside' && !!r.itemId && !finished
          const asking = reasonFor?.id === r.id ? reasonFor : null
          const from = givenFrom(r)
          const returnedWhy = (r.notGivenReason ?? '').replace(/^returned:\s*/i, '')
          return (
            <Row key={r.id} className="flex-wrap items-start gap-3 py-2">
              <Badge tone={STATE_TONE[state]} dot={false} className="mt-0.5">
                {t(STATE_LABEL[state])}
              </Badge>
              {/* wraps on a phone: the buttons go under the medicine instead of crushing it */}
              <span className="min-w-0 flex-[1_1_14rem]">
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
                    // "12 given · 18 outside": the remainder went outside as its own line
                    splitChild
                      ? t('clinical.splitLine', { given, outside: splitChild.quantity })
                      : null,
                    state === 'outside' ? t('clinical.notCharged') : null,
                    state === 'outside' && r.supplySetBy
                      ? t('clinical.decidedBy', { name: r.supplySetBy })
                      : null,
                    state === 'outside' ? r.supplyReason : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {state === 'notGiven' && canOutside && !asking && (
                  // the pharmacy could not give it: the patient may buy it outside
                  <span className="bg-orange-bg text-orange border-orange/25 mt-1.5 flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5 text-[13px] font-semibold">
                    <span className="min-w-0 flex-1">{t('clinical.sendOutsideCall')}</span>
                    <Button
                      size="sm"
                      onClick={() => void decideSupply(r, 'outside')}
                      loading={actions.setSupply.isPending}
                    >
                      <Store size={14} aria-hidden="true" />
                      {t('clinical.buyOutside')}
                    </Button>
                  </span>
                )}
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
                              ? finished
                                ? 'clinical.undoClosedHint'
                                : 'clinical.undoOpenHint'
                              : finished
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
              {state === 'waiting' && canOutside && !asking && (
                <Button
                  size="sm"
                  variant="ghost"
                  title={t('clinical.buyOutsideHint')}
                  onClick={() => void decideSupply(r, 'outside')}
                >
                  <Store size={14} aria-hidden="true" />
                  {t('clinical.buyOutside')}
                </Button>
              )}
              {canClinic && !asking && (
                <Button
                  size="sm"
                  variant="ghost"
                  title={t('clinical.giveAtClinicHint')}
                  onClick={() => void decideSupply(r, 'pharmacy')}
                >
                  <Pill size={14} aria-hidden="true" />
                  {t('clinical.giveAtClinic')}
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
              {/* 0104: no department gives the desk that does this test: the manager is told */}
              {!o.result &&
                o.status !== 'cancelled' &&
                (() => {
                  const desk = noDeskFor(o)
                  return desk ? (
                    <span className="text-orange mt-1 block text-xs font-semibold">
                      <TriangleAlert
                        size={12}
                        aria-hidden="true"
                        className="mr-1 inline-block align-[-1px]"
                      />
                      {t('clinical.noDeskForTest', { desk })}
                    </span>
                  ) : null
                })()}
              {/* the image or printout the laboratory / ultrasound attached to the test */}
              <TestFilesChip
                encounterId={encounterId}
                patientId={patientId}
                serviceRequestId={o.id}
                patientName={patient?.name}
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

      {clinician && !finished && (
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
              data && standing(data.diagnoses).some((d) => d.type === 'primary')
                ? 'text-ink-3'
                : 'text-red',
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
      {/* 0107: how the medicine is sold, and what the quantity is charged (cash price) */}
      {row && quantity > 0 && <GivenHereCharge row={row} quantity={quantity} />}
    </div>
  )
}

/** "1 box of 8 × 1,200 = 1,200", or "sold only by the whole box: give 8 or 16". */
function GivenHereCharge({
  row,
  quantity,
}: {
  row: NonNullable<ReturnType<typeof useStoreStock>['data']>['items'][number]
  quantity: number
}) {
  const { t } = useTranslation()
  const item = { ...row, sellingPrice: row.price }
  const p = priceQuantity(item, quantity)
  if (!p.ok)
    return (
      <span className="text-red text-[13px] font-semibold">
        {wholePacksText(t, quantity, item)}
      </span>
    )
  if (!row.packSize || row.packSize < 2 || row.price == null) return null
  return (
    <span className="text-teal text-[13px] font-medium tabular-nums">
      {saleModeText(t, item)} · {priceLineText(t, p, item, formatRwf)}
    </span>
  )
}
