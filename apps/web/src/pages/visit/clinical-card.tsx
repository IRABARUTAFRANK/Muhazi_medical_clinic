import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { SearchSelect } from '@/components/ui/search-select'
import { EmptyNote } from '@/components/clinical/empty-note'
import {
  FolderClosed,
  FolderOpen,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  ClipboardList,
  FileText,
  FlaskConical,
  HandHeart,
  History,
  ListChecks,
  Pencil,
  Pill,
  Plus,
  Printer,
  Stethoscope,
  Store,
  Trash2,
  TriangleAlert,
  X,
  XCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatRwf, formatTime, type StaffUser, type Tone } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Reveal } from '@/components/ui/reveal'
import { Button } from '@/components/ui/button'
import { WideResult } from '@/components/clinical/wide-result'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import {
  medicineRuleText,
  treatmentName,
  type Treatment,
  useMedicineReference,
  useListMedicines,
  listMedicineOption,
  tidyListName,
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
  NO_DIAGNOSIS_KINDS,
  type NoDiagnosisKind,
  type ClinicalNote,
  type DefinitiveSave,
  type Diagnosis,
  type TestOrder,
  type DocPerson,
  type Item,
  type Prescription,
  type PrescriptionState,
  type SectionKey,
  stageOf,
  type RecordVersion,
  type RxSupply,
  type RxWarning,
} from '@/lib/api/patients'
import { VisitEditLock } from '@/components/clinical/visit-edit-lock'
import { useEditWindow } from '@/components/clinical/edit-window'
import { useStockActions } from '@/lib/api/stock'
import { ApiError, errorKind } from '@/lib/api/errors'
import { useBillingActions, useVisitBill } from '@/lib/api/billing'
import { payerLine, useInsurerTariff, usePayerLines } from '@/lib/api/insurers'
import { useInsuranceEnabled } from '@/lib/api/settings'
import {
  insurerLineRule,
  insurerLineText,
  insurerLineTone,
  insurerRuleSub,
} from '@/lib/insurer-price'
import { TestFilesChip } from '@/components/clinical/supporting-files'
import { registrationText, useEmployees, useMyCredentials } from '@/lib/api/staff'
import { stationFor, type Station } from '@/lib/api/visits'
import { useMyDepartments } from '@/lib/api/staff'
import { buildPrescriptionHtml, type RxDoc, type RxDocMedicine } from '@/lib/prescription-doc'
import { BlankRxForm } from '@/components/clinical/blank-rx'
import { isDoctorUser, professionLabel, roleLabel } from '@/lib/roles'
import { ForDoctorsNote } from '@/components/clinical/record-privacy'
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
import { Seg } from '@/components/ui/seg'
import { noDiagnosisText } from '@/lib/no-diagnosis'
import { sixStepsOfVisit } from '@/lib/six-steps-report'
import { OUTCOME_TONE, confirmedLink, outcomeOf } from '@/lib/diagnosis-outcome'
import { NurseOrderRow } from '@/components/clinical/nurse-order-row'
import { StepBar, StepSlide } from '@/components/clinical/six-steps/step-card'
import { STEP_KEYS, stepNumber, type StepKey } from '@/components/clinical/six-steps/steps'
import { SectionEditor } from '@/components/clinical/six-steps/section-editor'
import { PastHistoryPanel } from '@/components/clinical/six-steps/past-history'
import { NurseOrdersStep } from '@/components/clinical/six-steps/nurse-orders-step'
import { BedStayStep } from '@/components/clinical/bed-stay'
import { useBedActions, useVisitBed } from '@/lib/api/beds'
import { isOnce, isRepeated, orderParts } from '@/lib/api/nurse-orders'
import { DefinitivePick } from '@/components/clinical/six-steps/definitive-pick'

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
  // 0173: a prescription is for an outside pharmacy; "given here" takes it from the clinic's stock
  supply: 'outside',
  supplyChosen: false,
  typedName: '',
  store: '',
  storeName: '',
})
/** The medicine picker's values: a clinic medicine is its id; one only on the official list is
 *  REF + its code; TYPED is a medicine written by hand (both only for an outside pharmacy). */
const REF = 'ref:'
/** 0172: a medicine of an uploaded price list the clinic does not hold: LIST + its code. */
const LIST = 'list:'
const TYPED = 'typed'
const outsideOnly = (value: string) =>
  value === TYPED || value.startsWith(REF) || value.startsWith(LIST)
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
/** The step of the record each form belongs to (0127): its messages are shown there. */
const MODE_STEP: Record<'note' | 'dd' | 'rx' | 'test', StepKey> = {
  note: 'exam',
  dd: 'differential',
  rx: 'plan',
  test: 'tests',
}
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
  // the visit's insurer (0115): what it pays for each medicine, said under the line
  const insurance = useInsuranceEnabled()
  const bill = useVisitBill(encounterId).data
  const payerId = bill?.payerId ?? null
  const insurerName = bill?.payerName ?? ''
  // 0148: a catalogue that cannot be read is said under the chooser (not "no test yet")
  const { data: treatments = [], error: treatmentsError } = useTreatments(true)
  // Orderable treatments, grouped by the desk that carries them out.
  const tests = treatments.filter((x) => x.orderStation)
  const desks = [...new Set(tests.map((x) => x.orderStation!))]
  // 0149: the treatments with no desk (charged on the bill from the same chooser); never
  // medicines (the prescription has its own list) nor the bed night (the beds board)
  const plainTreatments = treatments.filter((x) => !x.orderStation && x.code !== 'BED-STAY')
  const { data: myDepartments = [] } = useMyDepartments(user.id)
  const billing = useBillingActions(encounterId)
  // 0197: the patient's bed (step 6); finishing ends the stay first
  const bedNow = useVisitBed(encounterId)
  const bedActions = useBedActions()
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
  const lockedOut = !!lockedNote && (isDoctorUser(user) || user.role === 'nurse')
  const { data: deskInfo } = useMyDesks(user)
  /** Whose result is it: the laboratory or ultrasound desk of the test; a test done at another
   *  desk (Nursing, Dental…) also that desk's clinical staff. Never the clinician who asked for
   *  it (0104: the requester fallback is gone, in the database too). As the database checks. */
  const mayResult = (o: {
    station?: string | null
    category: 'lab' | 'imaging'
    doerId?: string | null
  }) =>
    // 0141: the doctor the ultrasound is assigned to writes its findings
    o.doerId === user.id ||
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
    // 0141: the region examined (an ultrasound)
    region: '',
  })
  // 0127: the step whose messages (errors, prescribing notes) are shown under it
  const [msgStep, setMsgStep] = useState<StepKey | 'finish'>('finish')
  // 0130: the six steps are shown one at a time (a slide); the one shown is in the URL (?step=3),
  // so a reload keeps it
  const { step: stepInUrl } = useSearch({ from: '/app/visit' })
  const navigate = useNavigate({ from: '/app/visit' })
  const step = stepNumber(stepInUrl)
  const [stepDir, setStepDir] = useState<1 | -1>(1)
  const barRef = useRef<HTMLDivElement>(null)
  const goStep = (n: number) => {
    if (n === step) return
    setStepDir(n > step ? 1 : -1)
    void navigate({ search: (prev) => ({ ...prev, step: n }), replace: true, resetScroll: false })
    // changed from the bottom of a long step: the bar comes back into view
    const bar = barRef.current
    if (bar && bar.getBoundingClientRect().top < 0) {
      const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      bar.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' })
    }
  }
  // 0197: the old "Diagnosis" tab (mode 'dx') is gone: a definitive diagnosis is step 5's form
  const [mode, setMode] = useState<'note' | 'dd' | 'rx' | 'test' | null>(null)
  // editing or removing a diagnosis, editing a note (0104): the line's form, with the reason
  const [dxEdit, setDxEdit] = useState<{
    id: string
    text: string
    provisional: boolean
    reason: string
  } | null>(null)
  const [dxRemove, setDxRemove] = useState<{ id: string; reason: string } | null>(null)
  const [noteEdit, setNoteEdit] = useState<{ id: string; text: string; reason: string } | null>(
    null,
  )
  // the previous versions unfolded, per line
  const [versionsOf, setVersionsOf] = useState<string | null>(null)
  /** The diagnoses still standing (a removed one leaves the list: the visit's change log keeps
   *  what was written, by whom it was withdrawn and why — 0142). */
  const standing = (list: Diagnosis[]) => list.filter((d) => !d.removedAt)
  // the clinic pharmacy's usable stock, and the official list for medicines bought outside
  const { data: rxStock = null } = useRxStock(mode === 'rx')
  const { data: refs = [] } = useMedicineReference(mode === 'rx')
  // 0172: the uploaded price lists' medicines the clinic does not hold
  const { data: listMeds = [] } = useListMedicines(mode === 'rx')

  // small forms
  const [note, setNote] = useState('')
  // 0130: no ICD-10 code, no type (the first definitive diagnosis is the primary one, in the
  // database), no "also in the differential list"
  const [dx, setDx] = useState({ text: '', provisional: false })
  const [rx, setRx] = useState<RxLine[]>([emptyLine()])
  // what the insurer pays for the lines on screen (0140): the medicines prescribed, the tests offered
  const { data: payerRows } = usePayerLines(
    insurance ? payerId : null,
    tests.map((x) => x.id),
    rx.map((l) => l.item).filter((x): x is string => !!x && x !== TYPED),
  )
  // the same medicine written twice: said once, kept on the second press
  const [twiceOk, setTwiceOk] = useState('')
  const setLine = (i: number, patch: Partial<RxLine>) =>
    setRx((lines) => lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const refOf = (value: string) =>
    value.startsWith(REF) ? refs.find((r) => r.code === value.slice(REF.length)) : undefined
  const listOf = (value: string) =>
    value.startsWith(LIST) ? listMeds.find((l) => l.code === value.slice(LIST.length)) : undefined
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
        // 0173: a prescription unless the prescriber chose "given here"
        const supply: RxSupply = l.supplyChosen ? l.supply : 'outside'
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
  // 0143: every medicine and product of the clinic (no store, stock or category filter), then the
  // official list's lines the clinic does not hold; on an insurer, its price on the right, its
  // rule as a second line, and what it does not cover in a last group (the patient pays)
  const { data: medTariff } = useInsurerTariff(insurance ? payerId : null)
  const medRule = (id: string) =>
    insurance && payerId
      ? insurerLineRule(medTariff?.rows.find((r) => r.kind === 'item' && r.id === id))
      : null
  const medPrice = (id: string, cash: number | null | undefined) => {
    const row =
      insurance && payerId
        ? medTariff?.rows.find((r) => r.kind === 'item' && r.id === id)
        : undefined
    return row?.price ?? cash ?? null
  }
  const notCoveredGroup = t('clinical.medGroups.notCovered', { insurer: insurerName })
  const medicineOptions = [
    { value: TYPED, label: t('clinical.typedMedicine') },
    ...items
      .map((it) => {
        const rule = medRule(it.id)
        const price = medPrice(it.id, it.cashPrice)
        return {
          value: it.id,
          label: [it.name, it.strength, it.form ? `· ${it.form}` : null].filter(Boolean).join(' '),
          group: rule === 'out' ? notCoveredGroup : t('clinical.medGroups.clinic'),
          hint: price == null ? undefined : formatRwf(price),
          sub: insurerRuleSub(t, rule, insurerName),
          keywords: it.code,
          rank: rule === 'out' ? 2 : 0,
        }
      })
      .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label)),
    // the official list's medicines the clinic does not hold: for an outside pharmacy
    ...sortMedicineRefs(refs.filter((r) => !itemCodes.has(r.code))).map((r) => ({
      ...medicineRefOption(r, t, REF + r.code),
      group: t('clinical.medGroups.rhia'),
      hint: t('clinical.stock.notSold'),
    })),
    // 0172: the uploaded lists' medicines the clinic does not hold: for an outside pharmacy
    ...listMeds
      .filter((l) => !itemCodes.has(l.code))
      .map((l) => ({
        ...listMedicineOption(l, t, LIST + l.code),
        group: t('clinical.medGroups.list', { list: l.listName }),
        hint: t('clinical.stock.notSold'),
      })),
  ]
  const [order, setOrder] = useState({
    services: [] as string[],
    reason: '',
    send: true,
    urgent: false,
    // 0141: who does an ultrasound: the ultrasound desk, me, or a doctor colleague (their id)
    scanBy: 'desk' as 'desk' | 'me' | 'other',
    scanDoctor: '',
  })
  // 0141: the doctors who may do an ultrasound in the doctor's place (appointed ones too)
  const { data: employees = [] } = useEmployees()
  const scanDoctors = employees.filter(
    (e) => e.active && e.id !== user.id && (e.isDoctor || e.role === 'doctor'),
  )
  const [localError, setLocalError] = useState<string | null>(null)
  // 0125: no primary diagnosis at Finish: "No diagnosis found" and why
  const [noDx, setNoDx] = useState<{ kind: NoDiagnosisKind; note: string } | null>(null)
  const confirm = useConfirm()
  const name = patient?.name || t('confirm.visit.thisPatient')
  const isManager = user.role === 'manager'
  // 0173: "Given here" comes from the clinic's one stock, whoever gives (no store to hold)
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
  // 0178: a prescription is for an outside pharmacy only; what the clinic gives here is an order
  // (a drug or a procedure, from the clinic's stock), so the supply is never asked here
  const supplies: RxSupply[] = ['outside']

  const letterhead = useLetterhead()
  const reportLabels = useMedicalReportLabels()
  // 0126: patient records are for doctors: someone who is not one sees their desk's part of an
  // open visit (view 'desk'), without the medical report
  const deskView = data?.view === 'desk'
  const doctor = isDoctorUser(user) && !deskView
  // 0127: the doctor's record of a visit is six steps; the desk view keeps its own list
  const stepper = !deskView
  // 0197: the desk view no longer shows the old tabs (Note, Diagnosis, Prescription, Tests &
  // exams): only what the person's role and desk do on a visit, each part under its plain name.
  // A nurse's note is a "nursing note"; another desk's is "your note".
  const noteWord = t(user.role === 'nurse' ? 'deskPart.nurseNote' : 'deskPart.note')
  /** The open orders to the nurses (listed when the visit is finished; they do not stop it). */
  const openOrders = (data?.nurseOrders ?? []).filter((o) => o.status === 'open')
  const [reporting, setReporting] = useState(openReport)
  // 0151: a finished visit is a closed file until someone opens it for review (or an edit code)
  const [reviewing, setReviewing] = useState(false)
  const [comment, setComment] = useState('')
  // the signed-in person's specialty and council registration (nulls before 0084)
  const { data: creds } = useMyCredentials(user.id)
  const [printingRx, setPrintingRx] = useState(false)
  // 0155: a prescription sheet to write by hand (empty lines), printed from the visit
  const [blankRx, setBlankRx] = useState(false)
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
    // 0127: the definitive diagnoses (step 5), never a possible one
    const list = data ? standing(data.diagnoses).filter((d) => stageOf(d) === 'definitive') : []
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
            doctor:
              data.sections?.complaint?.by ?? data.diagnoses[0]?.by ?? data.notes[0]?.by ?? null,
            vitals: report?.vitals ?? [],
            vitalsBy: report?.vitalsBy ?? null,
            vitalsAt: report?.vitalsAt ?? null,
            notes: data.notes.map((n) => n.text),
            // 0127: the six steps (complaint and history, examination, differential and definitive
            // diagnoses, plan, the orders to the nurses); a removed diagnosis is not part of it
            ...sixStepsOfVisit(data, t),
            tests: data.orders.map((o) => ({
              name: o.test,
              findings: o.result?.findings ?? null,
              impression: o.result?.impression ?? null,
              verified: !!o.result?.verified,
            })),
            treatments: report?.treatments ?? [],
            medicines,
            // 0125: no diagnosis found (its reason), and the next appointment booked
            noDiagnosis: data.visit?.noDiagnosis ? noDiagnosisText(data.visit.noDiagnosis) : null,
            nextAppointment: data.visit?.nextAppointment
              ? t('followUp.nextLine', {
                  when: when(data.visit.nextAppointment.at),
                  who: data.visit.nextAppointment.with ?? '',
                })
              : null,
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
          phone: p?.phone ?? null,
          insurer: p?.insurer ?? null,
          memberNo: p?.memberNo ?? null,
        },
        // 0130: no ICD-10 code (the visit no longer asks for one)
        diagnosis: dx ? { text: dx.text, provisional: dx.provisional } : null,
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
    // 0127: step 3, a possible diagnosis (0197: the only one written here — a definitive one is
    // step 5's own form, and the old "Diagnosis" tab of the desk view is gone)
    if (
      !(await confirm({
        title: t('sixSteps.ddQ', { dx: dx.text.trim(), name }),
        body: t('confirm.visit.recordBody'),
        confirmLabel: t('confirm.visit.saveYes'),
      }))
    )
      return
    void run(
      () =>
        actions.addDiagnosis
          .mutateAsync({ ...dx, stage: 'differential' as const })
          .then(() => setDx({ text: '', provisional: false })),
      t('sixSteps.ddSaved'),
    )
  }
  /**
   * 0192: step 5 saved in one go — the possible diagnoses ticked (confirmed), those left
   * unticked (not confirmed, under the doctor's name), the others typed. A refusal shows under
   * step 5 and nothing is saved. True when saved (the tick list then clears).
   */
  const saveDefinitive = async (i: DefinitiveSave): Promise<boolean> => {
    setMsgStep('definitive')
    setLocalError(null)
    onError(null)
    try {
      const r = await actions.saveDefinitive.mutateAsync(i)
      // a database before 0192: "not confirmed" is not kept; say so, and what was saved
      onDone(
        t(
          !r.partial
            ? 'sixSteps.pick.saved'
            : r.savedSome
              ? 'sixSteps.pick.needsUpdate'
              : 'sixSteps.pick.needsUpdateNothing',
        ),
      )
      return true
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e))
      return false
    }
  }
  /** 0127: one of the doctor's texts (steps 1, 2, 6). */
  const saveSection = (section: SectionKey) => async (text: string, reason: string | null) => {
    setLocalError(null)
    onError(null)
    try {
      await actions.saveSection.mutateAsync({ section, text, reason })
      onDone(t('sixSteps.sectionSaved', { what: t(`sixSteps.sections.${section}`) }))
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e))
      throw e
    }
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
      const lm = listOf(line.item)
      const name = item
        ? [item.name, item.strength].filter(Boolean).join(' ')
        : ref
          ? ref.presentation
            ? `${ref.generic} (${ref.presentation})`
            : ref.generic
          : lm
            ? tidyListName(lm.name)
            : line.item === TYPED
              ? line.typedName.trim()
              : ''
      const q = Number(line.quantity)
      if (!name || !Number.isFinite(q) || q <= 0) return setLocalError(t('clinical.errors.rx'))
      prepared.push({ item, name, code: ref?.code ?? lm?.code ?? null, line, q })
    }
    const ids = prepared.map((p) => p.item?.id ?? p.code ?? p.name.toLowerCase())
    const twice = [
      ...new Set(prepared.filter((_, i) => ids.indexOf(ids[i]!) !== i).map((p) => p.name)),
    ]
    if (twice.length > 0 && twiceOk !== ids.join(',')) {
      setTwiceOk(ids.join(','))
      return setLocalError(t('clinical.errors.rxTwice', { names: twice.join(', ') }))
    }
    const list = prepared
      .map((p) => {
        const label = `${p.name} × ${p.q}`
        return p.line.supply === 'room'
          ? `${label} (${t('clinical.givenHereTag')})`
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
          // 0173: from the clinic's stock (the database picks it)
          locationId: null,
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
    setMsgStep('plan')
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
    setMsgStep('plan')
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
  const isScan = (s: Treatment) => s.group === 'imaging' || s.orderStation === 'ultrasound'
  const submitOrder = async (e: FormEvent) => {
    e.preventDefault()
    const picked = order.services
      .map((id) => treatments.find((x) => x.id === id))
      .filter((x): x is Treatment => !!x)
    if (picked.length === 0) return setLocalError(t('clinical.errors.test'))
    // 0149: a treatment without a desk is charged on the bill; only the tests go to a desk
    const plain = picked.filter((x) => !x.orderStation)
    const chosen = picked.filter((x) => !!x.orderStation)
    if (chosen.length === 0) {
      const listP = plain.map((s) => treatmentName(s, i18n.language)).join(', ')
      if (
        !(await confirm({
          title: t('confirm.visit.treatments.title', { name }),
          body: t('confirm.visit.treatments.body', { list: listP }),
          confirmLabel: t('confirm.visit.treatments.yes'),
        }))
      )
        return
      void run(() => addPlain(plain), t('clinical.treatmentsAdded', { count: plain.length }))
      return
    }
    // 0141: an ultrasound done by a doctor: themselves or the colleague chosen; no queue at the desk
    const scans = chosen.some(isScan)
    const doer =
      !scans || order.scanBy === 'desk' ? null : order.scanBy === 'me' ? user.id : order.scanDoctor
    if (scans && order.scanBy === 'other' && !doer)
      return setLocalError(t('clinical.errors.scanDoctor'))
    if (doer && chosen.some((s) => !isScan(s))) return setLocalError(t('clinical.errors.scanOnly'))
    const list = picked.map((s) => treatmentName(s, i18n.language)).join(', ')
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
            from: order.send && !deskStaff && !doer ? (station ?? stationFor(user)) : null,
            urgent: order.urgent,
            doer,
          })
          .then(() => addPlain(plain))
          .then(() =>
            setOrder({
              services: [],
              reason: '',
              send: true,
              urgent: false,
              scanBy: order.scanBy,
              scanDoctor: order.scanDoctor,
            }),
          ),
      [
        t(
          doer
            ? doer === user.id
              ? 'clinical.scanBy.savedMe'
              : 'clinical.scanBy.savedOther'
            : order.send
              ? 'clinical.testsSent'
              : 'clinical.testsSaved',
          { count: chosen.length, name: scanDoctors.find((d) => d.id === doer)?.fullName ?? '' },
        ),
        plain.length ? t('clinical.treatmentsAdded', { count: plain.length }) : '',
      ]
        .filter(Boolean)
        .join(' '),
    )
  }
  /** 0149: the treatments without a desk, one bill line each (the insurer asked once if its rule says so). */
  const addPlain = async (plain: Treatment[]) => {
    const office = station ?? stationFor(user)
    for (const s of plain) {
      const input = {
        encounterId,
        office,
        serviceId: s.id,
        description: s.nameEn,
        listPrice: testPrice(s) ?? s.cashPrice ?? 0,
        quantity: 1,
        discountPct: 0,
        coveragePct: Number(bill?.coveragePct ?? 0),
        cashPrice: s.cashPrice ?? null,
      }
      try {
        await billing.addCharge.mutateAsync(input)
      } catch (e) {
        const asked =
          e instanceof ApiError && (e.hint === 'ask_insurer' || e.hint === 'insurer_preauth')
        if (!asked) throw e
        if (
          !(await confirm({
            title: t('confirm.visit.askInsurer', {
              item: treatmentName(s, i18n.language),
              insurer: insurerName,
            }),
            body: t('confirm.visit.askInsurerBody', { price: formatRwf(input.listPrice) }),
            confirmLabel: t('confirm.visit.askInsurerYes'),
          }))
        )
          throw e
        await billing.addCharge.mutateAsync({ ...input, confirm: true })
      }
    }
  }
  const toggleTest = (id: string) =>
    setOrder((o) => ({
      ...o,
      services: o.services.includes(id) ? o.services.filter((x) => x !== id) : [...o.services, id],
    }))
  const addTest = (id: string) =>
    setOrder((o) => (o.services.includes(id) ? o : { ...o, services: [...o.services, id] }))
  // 0130: the tests of the desks this person may ask, as one list grouped by desk; the price the
  // visit pays (the insurer's when it has one, else the cash price)
  const testPrice = (s: Treatment): number | null =>
    payerId
      ? (medTariff?.rows.find((r) => r.kind === 'service' && r.id === s.id)?.price ??
        payerLine(payerRows, { serviceId: s.id })?.price ??
        s.cashPrice)
      : s.cashPrice
  const testDesks = desks.filter((g) => !deskStaff || clinician || g === station)
  const testOption = (s: Treatment, group: string) => {
    const price = testPrice(s)
    return {
      value: s.id,
      label: treatmentName(s, i18n.language),
      group,
      hint: price != null ? formatRwf(price) : undefined,
      keywords: [s.code, s.nameEn, s.nameFr, s.nameKin].filter(Boolean).join(' '),
    }
  }
  // 0149: one list — the person's departments (their tests and treatments), then the desks'
  // tests (Laboratory, Ultrasound), then every other treatment of the clinic; a desk's staff
  // registering their own test see that desk only
  const placed = new Set<string>()
  const byName = (a: Treatment, b: Treatment) =>
    treatmentName(a, i18n.language).localeCompare(treatmentName(b, i18n.language))
  const offered = (s: Treatment) => !order.services.includes(s.id) && !placed.has(s.id)
  const testOptions = [
    ...(clinician
      ? myDepartments.flatMap((d) =>
          [...tests, ...plainTreatments]
            .filter((s) => s.departmentIds.includes(d.id) && offered(s))
            .sort(byName)
            .map((s) => (placed.add(s.id), testOption(s, d.name))),
        )
      : []),
    ...testDesks.flatMap((g) =>
      tests
        .filter((s) => s.orderStation === g && offered(s))
        .sort(byName)
        .map(
          (s) => (
            placed.add(s.id),
            testOption(s, t(`register.stations.${g}`, { defaultValue: g }))
          ),
        ),
    ),
    ...(clinician
      ? plainTreatments
          .filter(offered)
          .sort(byName)
          .map((s) => (placed.add(s.id), testOption(s, t('clinical.otherTreatmentsGroup'))))
      : []),
  ]
  const chosenTests = order.services
    .map((id) => treatments.find((x) => x.id === id))
    .filter((x): x is Treatment => !!x)
  const chosenDeskTests = chosenTests.filter((x) => !!x.orderStation)
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
    // 0192: a definitive diagnosis ticked from the possible ones: that one is not decided again
    const from = d.differentialId
      ? data?.diagnoses.find((x) => x.id === d.differentialId && !x.removedAt)
      : undefined
    if (
      !(await confirm({
        title: t('confirm.visit.removeDx', { dx: d.text, name }),
        body: [
          t('confirm.visit.removeDxBody', { reason: dxRemove.reason.trim() }),
          from ? t('confirm.visit.removeDxBack', { dx: from.text }) : null,
        ]
          .filter(Boolean)
          .join(' '),
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
  const hasPrimary =
    !!data &&
    (standing(data.diagnoses).some((d) => d.type === 'primary' && stageOf(d) === 'definitive') ||
      data.hasPrimaryDiagnosis === true)
  // 0127: step 1's chief complaint is needed to finish (a desk view knows without its words);
  // a database before 0127 has no complaint to ask for
  const complaintKnown = !!data && ('sections' in data || 'hasComplaint' in data)
  const hasComplaint = !complaintKnown || !!data?.sections?.complaint || data?.hasComplaint === true
  /** 0197: a patient in a bed: finishing the visit ends the stay first (the question says so). */
  const bedText = bedNow
    ? t('beds.confirm.finishBody', { name: bedNow.patient || name, bed: bedNow.bed.name })
    : null
  const endBedFirst = async () => {
    if (bedNow) await bedActions.end.mutateAsync({ encounterId, bedId: bedNow.bed.id })
  }
  /** "The orders not carried out yet: …", said when finishing (they do not stop it). */
  const openOrdersText = openOrders.length
    ? t('sixSteps.openOrders', {
        count: openOrders.length,
        list: openOrders
          .map((o) =>
            // 0193: an order carried out once says what waits; an older one keeps its count;
            // 0198: a repeated one has times planned, which stop when the visit is finished
            isRepeated(o)
              ? `${o.text} (${t('nurseOrders.repeatOpenShort')})`
              : isOnce(o)
                ? `${o.text} (${t(orderParts(o).home > 0 ? 'nurseOrders.openHomeShort' : 'nurseOrders.openShort')})`
                : `${o.text} (${o.given + o.notGiven}/${o.dosesPlanned ?? 0})`,
          )
          .join(', '),
      })
    : ''
  const finish = async () => {
    if (!data) return
    if (!hasComplaint) {
      setNoDx(null)
      setMsgStep('complaint')
      setLocalError(t('sixSteps.needComplaint'))
      if (stepper) goStep(1)
      return
    }
    // no primary diagnosis: the clinician says none was found, and why (0125), instead of a block
    // (0126: a desk view knows there is one, or the doctor's reason for none, without its words);
    // in step 5
    if (!hasPrimary && !data.hasNoDiagnosis) {
      setLocalError(null)
      setMsgStep('definitive')
      setNoDx((x) => x ?? { kind: 'no_disease', note: '' })
      if (stepper) goStep(5)
      return
    }
    if (
      !(await confirm({
        title: t('confirm.visit.finish', { name }),
        body: [t('confirm.visit.finishBody'), bedText, openOrdersText].filter(Boolean).join(' '),
        confirmLabel: bedNow ? t('beds.confirm.finishYes') : t('confirm.visit.finishYes'),
      }))
    )
      return
    void run(async () => {
      await endBedFirst()
      await actions.finishVisit.mutateAsync()
    }, t('clinical.finished'))
  }

  /** Finish with no diagnosis found: the reason is kept on the visit and printed in the reports. */
  const finishNoDx = async () => {
    if (!noDx) return
    if (!hasComplaint) return setLocalError(t('sixSteps.needComplaint'))
    if (noDx.kind === 'other' && noDx.note.trim().length < 3)
      return setLocalError(t('noDx.needNote'))
    const reason = noDiagnosisText({ kind: noDx.kind, note: noDx.note.trim() || null })
    if (
      !(await confirm({
        title: t('noDx.confirm', { name }),
        body: [t('noDx.confirmBody', { reason }), bedText, openOrdersText]
          .filter(Boolean)
          .join(' '),
        confirmLabel: bedNow ? t('beds.confirm.finishYes') : t('confirm.visit.finishYes'),
      }))
    )
      return
    void run(async () => {
      await endBedFirst()
      await actions.finishVisit.mutateAsync({ noDiagnosis: noDx.kind, note: noDx.note })
      setNoDx(null)
    }, t('noDx.finished'))
  }

  // A clinician without the right to request tests (a nurse, by default) is told why the button
  // is greyed and where treatments given here go.
  const noTests = clinician && !can('orders.write')
  const tabBtn = (k: NonNullable<typeof mode>, label: string, icon: React.ReactNode) => {
    const btn = (
      <Button
        size="sm"
        variant={mode === k ? 'primary' : 'default'}
        onClick={() => {
          setMode(mode === k ? null : k)
          setMsgStep(MODE_STEP[k])
        }}
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

  // ---------------------------------------------------------------- the pieces of the record
  const noteForm = (
    <Reveal focus block="nearest">
      <form onSubmit={submitNote} className="flex flex-col gap-2">
        <label className="text-ink-2 flex flex-col gap-1.5 text-[13px] font-semibold">
          {deskView ? noteWord : t('clinical.note')}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={4}
            placeholder={t(deskView ? 'deskPart.notePh' : 'clinical.notePh')}
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
  )
  // 0130: the diagnosis in words only: no ICD-10 code, no primary / secondary (the first
  // definitive diagnosis of the visit is the primary one), no "also in the differential list"
  const dxForm = (
    <Reveal focus block="nearest">
      <form
        onSubmit={submitDx}
        className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
      >
        <Field
          label={t('clinical.dx')}
          value={dx.text}
          onChange={(e) => setDx({ ...dx, text: e.target.value })}
          placeholder={t('clinical.dxPh')}
          required
        />
        <div className="flex flex-wrap items-end gap-3">
          <Button type="submit" variant="primary" loading={actions.addDiagnosis.isPending}>
            {t('sixSteps.saveDifferential')}
          </Button>
        </div>
        <p className="text-ink-3 col-span-full m-0 text-xs">{t('sixSteps.differentialHint')}</p>
      </form>
    </Reveal>
  )
  const rxForm = (
    <Reveal focus block="nearest">
      <form onSubmit={submitRx} className="flex flex-col gap-3">
        <p className="text-ink-3 m-0 text-xs">{t('clinical.rxHint')}</p>
        <p className="text-ink-3 m-0 text-xs">{t('clinical.rxPayHint')}</p>
        <p className="text-ink-3 m-0 text-xs">{t('clinical.rxOutsideHint')}</p>
        {rx.map((line, i) => (
          <fieldset
            key={i}
            className="border-border bg-hover/40 m-0 flex min-w-0 flex-col gap-3 rounded-md border p-3"
          >
            <legend className="text-ink-2 px-1 text-xs font-semibold">
              {t('clinical.medicineN', { n: i + 1 })}
            </legend>
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
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
                {/* on an insurer: its price for the medicine and the split (0115) */}
                {(() => {
                  if (!payerId || !line.item || outsideOnly(line.item) || line.supply === 'outside')
                    return null
                  const row = payerLine(payerRows, { itemId: line.item })
                  const text = insurerLineText(t, row, insurerName, Number(line.quantity) || 1)
                  const tone = insurerLineTone(row)
                  return text ? (
                    <span
                      className={cn(
                        'text-[13px] font-semibold',
                        tone === 'teal' ? 'text-teal' : tone === 'red' ? 'text-red' : 'text-amber',
                      )}
                    >
                      {text}
                    </span>
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
                onChange={(e) => setLine(i, { quantity: e.target.value.replace(/[^\d]/g, '') })}
                required
              />
              <Field
                label={t('clinical.days')}
                inputMode="numeric"
                value={line.days}
                onChange={(e) => setLine(i, { days: e.target.value.replace(/[^\d]/g, '') })}
              />
            </div>
            {/* the route and the frequency are sentences (“By mouth (oral)”, “Three times a day”): one
                per line on a phone, two up to a wide screen, so the choice made is never cut */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
              {supplies.length > 1 && (
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
                          // 22px corners: the same round ends on one line (36 px, 44 px on a touch screen), and room
                          // for a long label on two
                          'disabled:bg-hover disabled:text-ink-3 inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-[22px] border px-3 py-1 text-left text-[13px] leading-tight font-semibold disabled:cursor-not-allowed',
                          line.supply === k
                            ? k === 'outside'
                              ? 'border-orange bg-orange text-card'
                              : 'border-primary bg-primary text-on-primary'
                            : 'border-border bg-card text-ink-2 hover:bg-hover',
                        )}
                      >
                        {k === 'room' ? (
                          <HandHeart size={14} aria-hidden="true" />
                        ) : (
                          <Store size={14} aria-hidden="true" />
                        )}
                        {t(`clinical.supply.${k}`)}
                      </button>
                    )
                  })}
                </div>
              )}
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
            {refused?.key === line.key && (
              <div
                role="alert"
                className="bg-red-bg text-red flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-[13px] font-semibold"
              >
                <span className="min-w-0 flex-[1_1_12rem]">{refused.message}</span>
                <Button
                  size="sm"
                  onClick={() => {
                    setLine(i, { supply: 'outside', supplyChosen: true })
                    setRefused(null)
                  }}
                >
                  <Store size={14} aria-hidden="true" />
                  {t('clinical.switchToOutside')}
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
  )
  const testForm = (
    <Reveal block="nearest">
      <form onSubmit={submitOrder} className="flex flex-col gap-3">
        <p className="text-ink-3 m-0 text-xs">{t('clinical.testHint')}</p>
        {/* 0130: one searchable list grouped by desk (Laboratory, Ultrasound…), not every test
            spread out; the tests chosen are listed under it with their price */}
        {testOptions.length + chosenTests.length > 0 && (
          <div className="flex min-w-0 flex-col gap-1.5">
            <SearchSelect
              label={t('clinical.testPick')}
              value=""
              onChange={(id) => {
                if (id) addTest(id)
              }}
              emptyLabel={t('clinical.testPickEmpty')}
              options={testOptions}
              adder
            />
            {/* a desk view has no prescription part to point to (0197) */}
            <span className="text-ink-3 text-xs">
              {t(deskView ? 'deskPart.testPickHint' : 'clinical.testPickHint')}
            </span>
          </div>
        )}
        {chosenTests.length > 0 ? (
          <ul
            className="border-border divide-border m-0 flex flex-col divide-y rounded-md border p-0"
            aria-label={t('clinical.testsChosen', { count: chosenTests.length })}
          >
            {chosenTests.map((s) => {
              const price = testPrice(s)
              const label = treatmentName(s, i18n.language)
              return (
                // on a phone the price and the cross go under the name (to the right) instead of
                // squeezing it into a strip where a long word runs over the price
                <li
                  key={s.id}
                  className="anim-enter flex list-none flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2"
                >
                  <FlaskConical size={15} aria-hidden="true" className="text-primary flex-none" />
                  <span className="min-w-0 flex-[1_1_9rem]">
                    <span className="block text-[14px] font-semibold">{label}</span>
                    <span className="text-ink-3 block text-xs">
                      {t(`register.stations.${s.orderStation}`, {
                        defaultValue: s.orderStation ?? '',
                      })}
                    </span>
                  </span>
                  <span className="text-ink-2 ml-auto text-[13px] font-semibold whitespace-nowrap tabular-nums">
                    {price != null ? formatRwf(price) : t('clinical.testNoPrice')}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="px-2"
                    aria-label={t('clinical.testRemove', { test: label })}
                    title={t('clinical.testRemove', { test: label })}
                    onClick={() => toggleTest(s.id)}
                  >
                    <X size={16} aria-hidden="true" />
                  </Button>
                </li>
              )
            })}
            {chosenTests.length > 1 && (
              <li className="bg-hover/40 flex list-none items-center justify-end gap-2 px-3 py-2 text-[13px] font-semibold">
                {t('clinical.testsTotal', {
                  amount: formatRwf(chosenTests.reduce((sum, x) => sum + (testPrice(x) ?? 0), 0)),
                })}
              </li>
            )}
          </ul>
        ) : (
          tests.length > 0 && (
            <p className="text-ink-3 m-0 text-[13px]">{t('clinical.testNoneChosen')}</p>
          )
        )}
        {treatments.length === 0 &&
          (treatmentsError ? (
            <p role="alert" className="text-red m-0 text-[13px] font-semibold">
              {t('visit.add.loadFailed', { message: treatmentsError.message })}
            </p>
          ) : (
            <EmptyNote>{t('clinical.noTests')}</EmptyNote>
          ))}
        {/* 0142: the ultrasounds of the chooser are the treatments of a category ordered at the
            ultrasound desk (the Imaging category): none yet, say so */}
        {tests.length > 0 && !desks.includes('ultrasound') && (
          <p className="text-ink-3 m-0 text-[13px]">{t('clinical.noImagingHint')}</p>
        )}
        {/* 0141: who does an ultrasound — the desk, the doctor, a colleague */}
        {isDoctorUser(user) && chosenTests.some(isScan) && (
          <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend className="text-ink-2 mb-1 p-0 text-[13px] font-semibold">
              {t('clinical.scanBy.title')}
            </legend>
            <div role="radiogroup" className="flex flex-wrap gap-2">
              {(['desk', 'me', 'other'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={order.scanBy === m}
                  onClick={() => setOrder({ ...order, scanBy: m })}
                  className={cn(
                    'flex min-w-[12rem] flex-1 items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors',
                    order.scanBy === m
                      ? 'border-primary bg-primary-tint text-ink ring-primary/20 ring-2'
                      : 'border-border bg-surface text-ink-2 hover:bg-hover',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold">
                      {t(`clinical.scanBy.${m}`)}
                    </span>
                    <span className="text-ink-3 block text-xs">
                      {t(`clinical.scanBy.${m}Hint`)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            {order.scanBy === 'other' && (
              <Select
                label={t('clinical.scanBy.pick')}
                value={order.scanDoctor}
                onChange={(e) => setOrder({ ...order, scanDoctor: e.target.value })}
                required
              >
                <option value="">
                  {scanDoctors.length ? t('clinical.scanBy.pick') : t('clinical.scanBy.none')}
                </option>
                {scanDoctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.fullName}
                  </option>
                ))}
              </Select>
            )}
          </fieldset>
        )}
        <Field
          label={t('clinical.reason')}
          value={order.reason}
          onChange={(e) => setOrder({ ...order, reason: e.target.value })}
          placeholder={t('clinical.reasonPh')}
        />
        {(chosenDeskTests.length > 0 || chosenTests.length === 0) && (
          <>
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
          </>
        )}
        {chosenTests.length > chosenDeskTests.length && (
          <p className="text-ink-3 m-0 text-xs">
            {t('clinical.plainChosenHint', { count: chosenTests.length - chosenDeskTests.length })}
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          className="self-start"
          disabled={order.services.length === 0}
          loading={actions.orderTests.isPending || billing.addCharge.isPending}
        >
          <FlaskConical size={16} aria-hidden="true" />
          {chosenTests.length > 0 && chosenDeskTests.length === 0
            ? t('clinical.addTreatments', { count: chosenTests.length })
            : t('clinical.saveTests', { count: order.services.length || 1 })}
        </Button>
      </form>
    </Reveal>
  )
  const messages = (
    <>
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
          <Button size="sm" variant="ghost" className="self-start" onClick={() => setWarnings([])}>
            {t('common.close')}
          </Button>
        </div>
      )}
    </>
  )
  const renderNote = (n: ClinicalNote) => {
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
  }
  const renderDx = (d: Diagnosis) => {
    const editingThis = dxEdit?.id === d.id
    const removingThis = dxRemove?.id === d.id
    // 0127: a possible diagnosis (step 3); 0192: what the doctor decided about it in step 5 —
    // confirmed (ticked), not confirmed (saved unticked) or not decided — never the words
    const differential = stepper && stageOf(d) === 'differential'
    const outcome = differential ? outcomeOf(d, data?.diagnoses ?? []) : null
    const confirmedAs = differential ? confirmedLink(d, data?.diagnoses ?? []) : undefined
    const fromList = stepper && !differential && d.differentialId
    return (
      <Row key={d.id} className="flex-wrap items-start gap-3 py-2">
        {outcome ? (
          <Badge tone={OUTCOME_TONE[outcome]} dot={false} className="mt-0.5">
            {t(outcome === 'confirmed' ? 'sixSteps.confirmedBadge' : `dxOutcome.${outcome}`)}
          </Badge>
        ) : (
          <Badge tone={d.type === 'primary' ? 'blue' : 'grey'} dot={false} className="mt-0.5">
            {t(`clinical.type.${d.type}`)}
          </Badge>
        )}
        <span className="min-w-0 flex-[1_1_14rem]">
          {editingThis ? (
            <Reveal focus block="nearest">
              {/* 0130: the words only (the code and the type are no longer asked) */}
              <form onSubmit={submitDxEdit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field
                  label={t('clinical.dx')}
                  value={dxEdit.text}
                  onChange={(e) => setDxEdit({ ...dxEdit, text: e.target.value })}
                  required
                />
                {!stepper && (
                  <label className="flex min-h-9 items-center gap-2 text-[13px] font-semibold">
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={dxEdit.provisional}
                      onChange={(e) => setDxEdit({ ...dxEdit, provisional: e.target.checked })}
                    />
                    {t('clinical.provisional')}
                  </label>
                )}
                <span className="col-span-full">
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
              <span className="block font-semibold">
                {d.text}
                {d.provisional && !stepper && (
                  <span className="text-ink-3 ml-2 text-xs">({t('clinical.provisional')})</span>
                )}
              </span>
              <span className="text-ink-3 block text-xs">
                {[
                  when(d.at),
                  d.by,
                  confirmedAs
                    ? t('sixSteps.confirmedBy', {
                        name: confirmedAs.by ?? '',
                        when: when(confirmedAs.at),
                      })
                    : null,
                  outcome === 'not_confirmed' && d.notConfirmedAt
                    ? t('sixSteps.notConfirmedBy', {
                        name: d.notConfirmedBy ?? '',
                        when: when(d.notConfirmedAt),
                      })
                    : null,
                  fromList ? t('sixSteps.fromDifferential') : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
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
        {!editingThis && !removingThis && mayEditLine(d.byId) && (
          <span className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              title={t('clinical.editDxHint')}
              onClick={() => {
                setLocalError(null)
                setMsgStep(stageOf(d) === 'differential' ? 'differential' : 'definitive')
                setDxEdit({ id: d.id, text: d.text, provisional: d.provisional, reason: '' })
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
                setMsgStep(stageOf(d) === 'differential' ? 'differential' : 'definitive')
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
  }
  const renderRx = (r: Prescription) => {
    const state = prescriptionState(r)
    // the prescriber (or the manager) withdraws a line still waiting at the pharmacy; so
    // does the colleague who took the patient over (the holder of the visit, as the
    // database checks through the hand-over since 0091)
    const wrote = r.prescriberId ? r.prescriberId === user.id : !!r.by && r.by === user.name
    const tookOver = !readOnly && !wrote && !!holder && holder.split(', ').includes(user.name)
    // 0130: as the database: also the one who sent it outside, and a doctor working on the open
    // visit (the one who has the patient now); before, the button showed and the database refused
    const sentItOutside = state === 'outside' && !!r.supplySetBy && r.supplySetBy === user.name
    const treatingNow = doctor && clinician && !finished
    const canCancel =
      ((state === 'waiting' && r.pending !== false) || state === 'outside') &&
      !locked &&
      (isManager || wrote || tookOver || sentItOutside || treatingNow) &&
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
        ? data?.prescriptions.find((x) => x.splitFrom === r.id && !x.cancelledAt)
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
          <span className={cn('block font-semibold', state === 'cancelled' && 'line-through')}>
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
              state === 'room' && r.givenBy ? t('clinical.givenBy', { name: r.givenBy }) : null,
              state === 'notGiven' && r.notGivenReason
                ? t('clinical.notGivenWhy', { reason: r.notGivenReason })
                : null,
              state === 'returned' ? t('clinical.returnedWhy', { reason: returnedWhy }) : null,
              state === 'cancelled'
                ? t('clinical.cancelledWhy', { reason: r.cancelReason ?? '' })
                : null,
              state === 'cancelled' ? r.cancelledBy : null,
              // "12 given · 18 outside": the remainder went outside as its own line
              splitChild ? t('clinical.splitLine', { given, outside: splitChild.quantity }) : null,
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
              {/* the button goes under the sentence on a phone instead of squeezing it into a strip */}
              <span className="min-w-0 flex-[1_1_12rem]">{t('clinical.sendOutsideCall')}</span>
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
        {/* the line's buttons stay together: when the row is too narrow they go under the
            medicine as one group (not one beside it and the other alone on the next line) */}
        {!asking &&
          (canCancel ||
            (state === 'waiting' && canOutside) ||
            canClinic ||
            canReturn ||
            canUndo) && (
            <span className="flex max-w-full flex-wrap items-center gap-x-3 gap-y-2">
              {canCancel && (
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
              {state === 'waiting' && canOutside && (
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
              {canClinic && (
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
              {canReturn && (
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
              {canUndo && (
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
            </span>
          )}
      </Row>
    )
  }
  const renderOrder = (o: TestOrder) => (
    // wraps on a phone: the button goes under the test instead of crushing its words
    <Row key={o.id} className="flex-wrap items-start gap-3 py-2">
      <Badge tone={o.result ? 'green' : 'blue'} dot={false} className="mt-0.5">
        {o.station
          ? t(`register.stations.${o.station}`, { defaultValue: o.station })
          : o.category === 'imaging'
            ? t('register.stations.ultrasound')
            : t('register.stations.laboratory')}
      </Badge>
      <span className="min-w-0 flex-[1_1_14rem]">
        <span className="block font-semibold">
          {o.test} <span className="text-ink-3 text-xs">· {t(`clinical.status.${o.status}`)}</span>
        </span>
        {o.reason && <span className="text-ink-3 block text-xs">{o.reason}</span>}
        {/* 0141: an ultrasound done by a doctor, not the desk */}
        {o.doer && (
          <span className="text-teal block text-xs font-semibold">
            {t('clinical.scanDoneBy', { name: o.doer })}
          </span>
        )}
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
          // "Open wide" at the top right; in a narrow box it takes its own line and the result
          // keeps the whole width (it used to float, squeezing the words beside it letter by letter)
          <span className="bg-green-bg/60 mt-1 flex flex-row-reverse flex-wrap items-start gap-x-2 gap-y-0.5 rounded-md px-2.5 py-1.5 text-[13px]">
            {/* 0150: the result at reading size, in a panel */}
            <span className="flex-none">
              <WideResult
                result={{
                  test: o.test,
                  patient: patient?.name ?? null,
                  station: o.station
                    ? t(`register.stations.${o.station}`, { defaultValue: o.station })
                    : null,
                  region: o.result.detail?.region ?? null,
                  findings: o.result.findings ?? null,
                  impression: o.result.impression ?? null,
                  verified: o.result.verified,
                  corrected: !!o.result.corrected,
                  correctionReason: o.result.correctionReason ?? null,
                  by: o.result.by ?? null,
                  at: o.result.at ?? null,
                  doer: o.doer ?? null,
                  orderedBy: null,
                  orderedAt: o.at ?? null,
                  reason: o.reason ?? null,
                }}
              />
            </span>
            <span className="min-w-0 flex-[1_1_8rem]">
              {o.result.detail?.region && (
                <span className="text-ink-2 block text-xs font-semibold">
                  {t('clinical.region')}: {o.result.detail.region}
                </span>
              )}
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
          </span>
        )}
        {resultFor === o.id && (
          <Reveal focus block="nearest">
            <form
              className="mt-2 flex flex-col gap-2"
              onSubmit={async (e) => {
                e.preventDefault()
                setMsgStep('tests')
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
                      .mutateAsync({
                        requestId: o.id,
                        findings: result.findings,
                        impression: result.impression,
                        verify: result.verify,
                        correction: result.correction,
                        detail: result.region.trim() ? { region: result.region.trim() } : null,
                      })
                      .then(() => setResultFor(null)),
                  t('clinical.resultSaved'),
                )
              }}
            >
              {/* 0141: an ultrasound: the region examined */}
              {o.category === 'imaging' && (
                <label className="text-ink-2 flex flex-col gap-1 text-[13px] font-semibold">
                  {t('clinical.region')}
                  <input
                    className="border-border bg-card h-10 rounded-md border px-2.5 text-[14px] font-normal"
                    placeholder={t('clinical.regionPh')}
                    value={result.region}
                    onChange={(e) => setResult({ ...result, region: e.target.value })}
                  />
                </label>
              )}
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
              <span className="flex flex-wrap gap-2">
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
                <Button type="button" size="sm" variant="ghost" onClick={() => setResultFor(null)}>
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
                region: o.result?.detail?.region ?? '',
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
  )
  const noDxNotice = data?.visit?.noDiagnosis ? (
    <CardBody className="border-border bg-amber-bg/50 flex-row flex-wrap items-center gap-2 border-t py-2.5 text-[14px]">
      <CircleSlash size={16} aria-hidden="true" className="text-amber" />
      <span className="font-semibold">{noDiagnosisText(data.visit.noDiagnosis)}</span>
      <span className="text-ink-3 text-xs">
        {[
          data.visit.noDiagnosis.by,
          data.visit.noDiagnosis.at ? when(data.visit.noDiagnosis.at) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
      <span className="text-ink-3 basis-full text-xs">{t('noDx.clearsHint')}</span>
    </CardBody>
  ) : null
  const noDxPanel =
    clinician && !finished && noDx ? (
      <CardBody className="border-border gap-3 border-t">
        <Reveal focus>
          <div className="border-amber/40 bg-amber-bg/40 flex flex-col gap-3 rounded-md border p-3">
            <span className="flex items-center gap-2 text-[15px] font-semibold">
              <CircleSlash size={16} aria-hidden="true" className="text-amber" />
              {t('noDx.title')}
            </span>
            <p className="text-ink-2 m-0 text-[14px]">{t('noDx.lead')}</p>
            <Seg
              label={t('noDx.title')}
              value={noDx.kind}
              onChange={(k) => setNoDx({ ...noDx, kind: k })}
              options={NO_DIAGNOSIS_KINDS.map((k) => ({ value: k, label: t(`noDx.kinds.${k}`) }))}
              className="self-start"
            />
            <Field
              label={t(noDx.kind === 'other' ? 'noDx.noteOther' : 'noDx.note')}
              value={noDx.note}
              maxLength={500}
              required={noDx.kind === 'other'}
              placeholder={t('noDx.notePh')}
              onChange={(e) => setNoDx({ ...noDx, note: e.target.value })}
            />
            <span className="flex flex-wrap gap-2">
              <Button
                variant="success"
                onClick={() => void finishNoDx()}
                loading={actions.finishVisit.isPending}
              >
                <CheckCircle2 size={16} aria-hidden="true" />
                {t('noDx.finish')}
              </Button>
              <Button variant="ghost" onClick={() => setNoDx(null)}>
                {t('noDx.addDiagnosis')}
              </Button>
            </span>
          </div>
        </Reveal>
      </CardBody>
    ) : null
  // 0127: what finishing needs, ticked as the doctor goes: the complaint (step 1), a definitive
  // primary diagnosis or the reason none was found (step 5)
  const dxOrReason = hasPrimary || !!data?.visit?.noDiagnosis || data?.hasNoDiagnosis === true
  const finishBar =
    !clinician || finished ? null : deskView && !(hasComplaint && dxOrReason) ? (
      // 0197: the main complaint and the diagnosis (or the reason none was found) are the
      // doctor's to write. Until they are there, someone who is not a doctor is told so in words,
      // instead of a Finish button that only refuses (or asks a nurse for a diagnosis)
      <CardBody className="border-border border-t">
        <p className="text-ink-2 m-0 flex items-start gap-2 text-[13px]">
          <Stethoscope size={16} aria-hidden="true" className="text-ink-3 mt-0.5 flex-none" />
          <span className="min-w-0">{t('deskPart.finishByDoctor')}</span>
        </p>
      </CardBody>
    ) : (
      <CardBody className="border-border gap-3 border-t">
        {stepper && (
          <ul
            className="m-0 flex flex-col gap-1 p-0 text-[13px]"
            aria-label={t('sixSteps.toFinish')}
          >
            {[
              { ok: hasComplaint, key: 'sixSteps.needs.complaint', step: 'complaint' },
              { ok: dxOrReason, key: 'sixSteps.needs.diagnosis', step: 'definitive' },
            ].map((x) => (
              <li
                key={x.key}
                className={cn(
                  'flex list-none items-center gap-2 font-semibold',
                  x.ok ? 'text-green' : 'text-ink-2',
                )}
              >
                {x.ok ? (
                  <CheckCircle2 size={15} aria-hidden="true" />
                ) : (
                  <CircleDashed size={15} aria-hidden="true" className="text-red" />
                )}
                <button
                  type="button"
                  onClick={() => goStep(STEP_KEYS.indexOf(x.step as StepKey) + 1)}
                  className="cursor-pointer bg-transparent p-0 text-left font-semibold text-inherit hover:underline"
                >
                  {t(x.key)}
                </button>
              </li>
            ))}
            {openOrders.length > 0 && (
              <li className="text-ink-3 flex list-none items-center gap-2">
                <ClipboardList size={15} aria-hidden="true" />
                {t('sixSteps.openOrdersNote', { count: openOrders.length })}
              </li>
            )}
          </ul>
        )}
        <span className="flex flex-wrap items-center gap-3">
          <Button
            variant="success"
            onClick={() => {
              setMsgStep('finish')
              void finish()
            }}
            loading={actions.finishVisit.isPending}
          >
            <CheckCircle2 size={16} aria-hidden="true" />
            {t('clinical.finish')}
          </Button>
          <span className={cn('min-w-0 text-xs', dxOrReason ? 'text-ink-3' : 'text-red')}>
            {t(stepper ? 'sixSteps.finishHint' : 'deskPart.finishHint')}
          </span>
        </span>
      </CardBody>
    )

  /** The messages under the step they belong to (the last one acted on). */
  const msgIn = (k: StepKey | 'finish') => (msgStep === k ? messages : null)
  const section = (k: SectionKey, rows: number, template?: string) => (
    <SectionEditor
      section={k}
      value={data?.sections?.[k]}
      editable={clinician}
      needReason={finished}
      rows={rows}
      patientName={name}
      template={template}
      onSave={(text, reason) => {
        setMsgStep(
          k === 'hpi' ? 'complaint' : k === 'exam' ? 'exam' : k === 'plan' ? 'plan' : 'complaint',
        )
        return saveSection(k)(text, reason)
      }}
    />
  )
  const diagnoses = data ? standing(data.diagnoses) : []
  const differentials = diagnoses.filter((d) => stageOf(d) === 'differential')
  const definitive = diagnoses.filter((d) => stageOf(d) === 'definitive')
  const live = (list: Diagnosis[]) => standing(list).length > 0
  const nurseOrders = data?.nurseOrders ?? []
  // 0130: the six steps as slides under a bar (the owner: "like a slide, not that long")
  const stepStates = [
    { step: 'complaint' as const, done: !!data?.sections?.complaint, required: true },
    { step: 'exam' as const, done: !!data?.sections?.exam },
    { step: 'differential' as const, done: live(differentials) },
    { step: 'tests' as const, done: (data?.orders.length ?? 0) > 0 },
    { step: 'definitive' as const, done: dxOrReason, required: true },
    {
      step: 'plan' as const,
      done:
        !!data?.sections?.plan ||
        !!data?.prescriptions.some((r) => !r.cancelledAt) ||
        nurseOrders.length > 0,
    },
  ]
  const stepAside: Partial<Record<StepKey, ReactNode>> = {
    exam:
      !readOnly &&
      tabBtn('note', t('clinical.addNote'), <ClipboardList size={14} aria-hidden="true" />),
    differential:
      !readOnly &&
      tabBtn('dd', t('sixSteps.addDifferential'), <Plus size={14} aria-hidden="true" />),
    tests:
      !readOnly &&
      tabBtn('test', t('clinical.addTest'), <FlaskConical size={14} aria-hidden="true" />),
    // 0192: step 5 is its own form (the tick list, the other diagnoses, one save)
  }
  const stepBody: Record<StepKey, ReactNode> = data
    ? {
        complaint: (
          <>
            {section('complaint', 1)}
            {section('hpi', 4)}
            <PastHistoryPanel
              encounterId={encounterId}
              patientId={patientId ?? data.patient?.id ?? null}
              patientName={name}
              onMessage={onDone}
            />
            {msgIn('complaint')}
          </>
        ),
        exam: (
          <>
            {section('exam', 6, t('sixSteps.examTemplate'))}
            {mode === 'note' && noteForm}
            {data.notes.length > 0 && (
              <div className="flex flex-col">
                <span className="text-ink-2 text-[13px] font-semibold">
                  {t('sixSteps.otherNotes')}
                </span>
                <div className="border-border -mx-3 border-t sm:-mx-4">
                  {data.notes.map(renderNote)}
                </div>
              </div>
            )}
            {msgIn('exam')}
          </>
        ),
        differential: (
          <>
            {mode === 'dd' && dxForm}
            {differentials.length > 0 ? (
              <div className="border-border -mx-3 border-t sm:-mx-4">
                {differentials.map(renderDx)}
              </div>
            ) : (
              <EmptyNote>{t('sixSteps.noDifferential')}</EmptyNote>
            )}
            {/* 0192: they are confirmed (ticked) in step 5, all at once */}
            {clinician && differentials.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="self-start"
                onClick={() => goStep(STEP_KEYS.indexOf('definitive') + 1)}
              >
                <ListChecks size={14} aria-hidden="true" />
                {t('sixSteps.goConfirm')}
              </Button>
            )}
            {msgIn('differential')}
          </>
        ),
        tests: (
          <>
            {noTests && <p className="text-ink-3 m-0 text-xs">{t('clinical.testsWhoHint')}</p>}
            {mode === 'test' && testForm}
            {data.orders.length > 0 ? (
              <div className="border-border -mx-3 border-t sm:-mx-4">
                {data.orders.map(renderOrder)}
              </div>
            ) : (
              <EmptyNote>{t('sixSteps.noTests')}</EmptyNote>
            )}
            {msgIn('tests')}
          </>
        ),
        definitive: (
          <>
            {/* 0192: tick the confirmed possible diagnoses, write any other, save once */}
            {clinician && (
              <DefinitivePick
                differentials={differentials}
                definitive={definitive}
                hasPrimary={hasPrimary}
                primaryText={primaryDx()?.text ?? null}
                noDiagnosisText={
                  data.visit?.noDiagnosis ? noDiagnosisText(data.visit.noDiagnosis) : null
                }
                patientName={name}
                saving={actions.saveDefinitive.isPending}
                onSave={saveDefinitive}
              />
            )}
            {definitive.length > 0 ? (
              <div className="border-border -mx-3 border-t sm:-mx-4">
                {definitive.map(renderDx)}
              </div>
            ) : (
              !data.visit?.noDiagnosis && <EmptyNote>{t('sixSteps.noDefinitive')}</EmptyNote>
            )}
            {noDxNotice && <div className="-mx-3 sm:-mx-4">{noDxNotice}</div>}
            {noDxPanel && <div className="-mx-3 sm:-mx-4">{noDxPanel}</div>}
            {msgIn('definitive')}
          </>
        ),
        plan: (
          <>
            {section('plan', 4)}
            <div className="flex flex-col gap-2">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-ink-2 text-[13px] font-semibold">
                  {t('sixSteps.prescriptions')}
                </span>
                {!readOnly &&
                  tabBtn('rx', t('clinical.addRx'), <Pill size={14} aria-hidden="true" />)}
              </span>
              {mode === 'rx' && rxForm}
              {data.prescriptions.length > 0 ? (
                <div className="border-border -mx-3 border-t sm:-mx-4">
                  {data.prescriptions.map(renderRx)}
                </div>
              ) : (
                <EmptyNote>{t('sixSteps.noPrescriptions')}</EmptyNote>
              )}
            </div>
            {msgIn('plan')}
            <NurseOrdersStep
              encounterId={encounterId}
              orders={nurseOrders}
              canOrder={clinician && doctor && !finished}
              myId={user.id}
              isManager={isManager}
              patientName={name}
              patientFile={patient?.fileNumber ?? null}
              visitOver={finished}
              // 0198: a repeat on a patient not in a bed warns that the times stop with the visit
              inBed={!!bedNow}
              // 0197: a medicine the clinic does not have: prescribed to buy outside instead
              onPrescribeOutside={(pick) => {
                setMsgStep('plan')
                setLocalError(null)
                setRx((lines) => [...lines.filter((l) => l.item), { ...emptyLine(), item: pick }])
                setMode('rx')
              }}
              onDone={onDone}
              onError={(m) => {
                setMsgStep('plan')
                setLocalError(m)
              }}
            />
            {/* 0197: the patient kept in a bed (billed by the day until the stay ends) */}
            <BedStayStep
              encounterId={encounterId}
              patientName={name}
              canAct={clinician && !finished}
              visitOver={finished}
              onDone={(m) => {
                setMsgStep('plan')
                onDone(m)
              }}
            />
          </>
        ),
      }
    : { complaint: null, exam: null, differential: null, tests: null, definitive: null, plan: null }
  const shortTitle = (n: number) => t(`sixSteps.${STEP_KEYS[n - 1]}.short`)
  const steps = stepper && data && (
    <CardBody className="border-border gap-3 border-t px-2 pt-3 sm:px-4">
      <div ref={barRef} className="flex min-w-0 scroll-mt-24 flex-col gap-2">
        <StepBar steps={stepStates} current={step} onPick={goStep} />
        {/* what finishing needs, near the bar (the Finish button is on step 6) */}
        {clinician && !finished && (
          <p className="text-ink-3 m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="font-semibold">{t('sixSteps.toFinishShort')}</span>
            {[
              { ok: hasComplaint, n: 1 },
              { ok: dxOrReason, n: 5 },
            ].map((x) => (
              <button
                key={x.n}
                type="button"
                onClick={() => goStep(x.n)}
                className={cn(
                  'inline-flex cursor-pointer items-center gap-1 bg-transparent p-0 font-semibold hover:underline',
                  x.ok ? 'text-green' : 'text-red',
                )}
              >
                {x.ok ? (
                  <CheckCircle2 size={13} aria-hidden="true" />
                ) : (
                  <CircleDashed size={13} aria-hidden="true" />
                )}
                {x.n} · {shortTitle(x.n)}
              </button>
            ))}
            {step !== STEP_KEYS.length && (
              <button
                type="button"
                onClick={() => goStep(STEP_KEYS.length)}
                className="text-primary cursor-pointer bg-transparent p-0 font-semibold hover:underline"
              >
                {t('sixSteps.goFinish')}
              </button>
            )}
          </p>
        )}
      </div>
      {STEP_KEYS.map((k, i) => {
        const n = i + 1
        const st = stepStates[i]!
        return (
          <StepSlide
            key={k}
            n={n}
            total={STEP_KEYS.length}
            step={k}
            done={st.done}
            required={st.required}
            active={n === step}
            direction={stepDir}
            aside={stepAside[k]}
            prevTitle={n > 1 ? shortTitle(n - 1) : undefined}
            nextTitle={n < STEP_KEYS.length ? shortTitle(n + 1) : undefined}
            onPrev={n > 1 ? () => goStep(n - 1) : undefined}
            onNext={n < STEP_KEYS.length ? () => goStep(n + 1) : undefined}
          >
            {stepBody[k]}
          </StepSlide>
        )
      })}
    </CardBody>
  )
  // 0197: the desk view — which parts the person has on this visit. Someone at a treating desk
  // (a nurse) writes a note; the lab, the ultrasound and whoever holds the right to request tests
  // add one; nothing is shown that would only refuse when pressed.
  const mayDeskNote = deskView && clinician
  const mayDeskTest = deskView && (clinician || deskStaff) && can('orders.write')
  const showDeskNotes = mayDeskNote || (data?.notes.length ?? 0) > 0
  const showDeskTests = mayDeskTest || (data?.orders.length ?? 0) > 0
  const deskDiagnoses = deskView && data ? standing(data.diagnoses) : []
  const deskEmpty =
    !!data &&
    !showDeskNotes &&
    !showDeskTests &&
    nurseOrders.length + data.prescriptions.length + deskDiagnoses.length === 0
  /** Where a message shows in the desk view: in the part it belongs to, else above the parts. */
  const hasMessages = !!localError || warnings.length > 0
  const deskMsgAt: 'notes' | 'tests' | 'finish' | 'top' =
    msgStep === 'exam' && showDeskNotes
      ? 'notes'
      : msgStep === 'tests' && showDeskTests
        ? 'tests'
        : msgStep === 'finish' || msgStep === 'complaint' || msgStep === 'definitive'
          ? 'finish'
          : 'top'
  const deskOther = deskView && hasMessages && deskMsgAt === 'top'
  /** The heading of a part of the desk view: its icon and name, the button that adds to it. */
  const deskHead = (icon: ReactNode, title: string, action?: ReactNode) => (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-ink flex min-w-0 items-center gap-2 text-[15px] font-semibold">
        {icon}
        <span className="min-w-0">{title}</span>
      </span>
      {action}
    </span>
  )
  // 0151: a finished visit is a closed file — the patient's name, when it was closed, the
  // diagnoses — opened for reading (or an edit code) on request; a new visit is its own record
  if (stepper && finished && !editing && !reviewing && data) {
    const closedAt = lock?.closedAt ?? data.visit?.closedAt ?? null
    return (
      <Card>
        <CardHeader hue="grey">
          <span className="inline-flex items-center gap-2">
            <FolderClosed size={16} aria-hidden="true" />
            {t('closedFile.title', { name: patient?.name ?? '' })}
          </span>
          <Badge tone="green" dot={false}>
            {t('closedFile.closed')}
          </Badge>
        </CardHeader>
        <CardBody className="gap-3">
          <p className="text-ink-2 m-0 text-[14px]">
            {[
              closedAt ? t('closedFile.closedOn', { when: when(closedAt) }) : null,
              lock?.closedBy ? t('closedFile.by', { name: lock.closedBy }) : null,
              data.visit?.reference ?? null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {definitive.length > 0 ? (
            <p className="m-0 text-[14px]">
              <span className="text-ink-3">{t('closedFile.diagnoses')}: </span>
              <span className="font-semibold">{definitive.map((d) => d.text).join(', ')}</span>
            </p>
          ) : data.visit?.noDiagnosis ? (
            <p className="m-0 text-[14px] font-semibold">
              {noDiagnosisText(data.visit.noDiagnosis)}
            </p>
          ) : null}
          <p className="text-ink-3 m-0 text-[13px]">{t('closedFile.hint')}</p>
          <span className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => setReviewing(true)}>
              <FolderOpen size={16} aria-hidden="true" />
              {t('closedFile.open')}
            </Button>
            {patient && doctor && (
              <Button
                variant="default"
                onClick={() => {
                  setReviewing(true)
                  setReporting(true)
                }}
              >
                <FileText size={16} aria-hidden="true" />
                {t('medReport.open')}
              </Button>
            )}
          </span>
        </CardBody>
      </Card>
    )
  }
  return (
    <Card>
      <CardHeader hue="navy">
        <span className="inline-flex items-center gap-2">
          <Stethoscope size={16} aria-hidden="true" />
          {t(stepper ? 'sixSteps.cardTitle' : 'deskPart.title')}
        </span>
        <span className="inline-flex flex-wrap items-center gap-2">
          {data?.patient?.bloodGroup && (
            <Badge tone="grey" dot={false}>
              {t('file.fields.blood_group')} {data.patient.bloodGroup}
            </Badge>
          )}
          {patient && data && doctor && (
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
          {patient && doctor && (
            <Button
              size="sm"
              variant={blankRx ? 'default' : 'ghost'}
              onClick={() => setBlankRx((b) => !b)}
              title={t('rxDoc.blank.hint')}
            >
              <Printer size={14} aria-hidden="true" />
              {t('rxDoc.blank.button')}
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
      {blankRx && patient && (
        <CardBody>
          <BlankRxForm
            user={user}
            patient={{
              name: patient.name,
              fileNumber: patient.fileNumber,
              birthDate: data?.patient?.birthDate ?? null,
              sex: data?.patient?.sex ?? null,
              weight: data?.patient?.weightKg ?? patient.weight ?? null,
              phone: data?.patient?.phone ?? null,
              insurer: data?.patient?.insurer ?? null,
              memberNo: data?.patient?.memberNo ?? null,
            }}
            onClose={() => setBlankRx(false)}
          />
        </CardBody>
      )}
      {/* the record is the manager's switch: said, not silently read only */}
      {!readOnly && canDesk(TREATING_DESKS) && switchedOff('clinical.write') && (
        <CardBody>
          <NotAllowedNotice feature="clinical.write" compact />
        </CardBody>
      )}
      {deskView && (
        <CardBody className="border-border border-b py-2.5">
          <ForDoctorsNote desk />
        </CardBody>
      )}
      {reporting && doctor && patient && data && (
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
      {/* the desk view has no lead and no buttons here: an empty band is not drawn */}
      <CardBody
        className={cn(
          'gap-3',
          deskView && !error && !finished && !lockedNote && !deskOther && 'hidden',
        )}
      >
        {error && <p className={errorBox}>{error.message}</p>}
        {stepper && finished && !editing && reviewing && (
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" onClick={() => setReviewing(false)}>
              <FolderClosed size={14} aria-hidden="true" />
              {t('closedFile.close')}
            </Button>
          </div>
        )}
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
        {stepper && !readOnly && clinician && (
          <p className="text-ink-2 m-0 text-[13px]">{t('sixSteps.lead')}</p>
        )}
        {stepper && !clinician && !readOnly && (
          <p className="text-ink-3 m-0 text-xs">{t('clinical.readOnly')}</p>
        )}
        {/* a message that belongs to no part below (an order carried out, a medicine line) */}
        {deskOther && messages}
      </CardBody>

      {/* 0127: the doctor's record, in six steps */}
      {steps}

      {/* 0141: what the ward added to the bill (acts, medicines) besides the doctor's orders */}
      {data && (data.extras?.length ?? 0) > 0 && (
        <CardBody className="border-border gap-2 border-t">
          <span className="text-ink flex items-center gap-2 text-[15px] font-semibold">
            <ClipboardList size={16} aria-hidden="true" className="text-amber" />
            {t('clinical.extras.title', { count: data.extras!.length })}
          </span>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {data.extras!.map((x) => (
              <li key={x.id} className="flex flex-wrap items-baseline gap-x-2 text-[14px]">
                <span className="font-semibold">
                  {x.quantity !== 1 ? `${x.quantity} × ` : ''}
                  {x.description}
                </span>
                <span className="text-ink-3 text-xs">
                  {[
                    t('clinical.extras.by', {
                      name: x.by ?? '',
                      role: x.byRole ? professionLabel({ role: x.byRole }, t) : '',
                    }),
                    t(x.ordered ? 'clinical.extras.ordered' : 'clinical.extras.notOrdered'),
                    when(x.at),
                  ].join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        </CardBody>
      )}

      {/* the desk view (0126; 0197: no tabs — each part the person works on, under its name):
          first the orders for them (0127) */}
      {deskView && data && nurseOrders.length > 0 && (
        <CardBody className="border-border gap-2 border-t">
          {deskHead(
            <ClipboardList size={16} aria-hidden="true" className="text-teal flex-none" />,
            t('nurseOrders.forYouTitle', { count: nurseOrders.length }),
          )}
          {nurseOrders.map((o) => (
            <NurseOrderRow
              key={o.id}
              order={o}
              patientName={name}
              patientFile={patient?.fileNumber ?? null}
              myId={user.id}
              isManager={isManager}
              visitOver={finished}
              carryOut={o.mine && can('clinical.write') && !finished}
              onDone={onDone}
              onError={(m) => {
                setMsgStep('plan')
                setLocalError(m)
              }}
            />
          ))}
        </CardBody>
      )}
      {/* the person's own notes: a nurse writes her nursing note here (add_clinical_note) */}
      {deskView && data && showDeskNotes && (
        <>
          <CardBody className="border-border gap-2 border-t">
            {deskHead(
              <ClipboardList size={16} aria-hidden="true" className="text-primary flex-none" />,
              t(user.role === 'nurse' ? 'deskPart.nurseNotes' : 'deskPart.notes'),
              mayDeskNote && (
                <Button
                  size="sm"
                  variant={mode === 'note' ? 'primary' : 'default'}
                  onClick={() => {
                    setMode(mode === 'note' ? null : 'note')
                    setMsgStep('exam')
                  }}
                >
                  <Plus size={14} aria-hidden="true" />
                  {t(user.role === 'nurse' ? 'deskPart.addNurseNote' : 'deskPart.addNote')}
                </Button>
              ),
            )}
            {mayDeskNote && <p className="text-ink-3 m-0 text-xs">{t('deskPart.noteHint')}</p>}
            {mode === 'note' && mayDeskNote && noteForm}
            {deskMsgAt === 'notes' && messages}
            {data.notes.length === 0 && mode !== 'note' && (
              <EmptyNote>{t('deskPart.noNotes')}</EmptyNote>
            )}
          </CardBody>
          {data.notes.map(renderNote)}
        </>
      )}
      {/* the tests the person's desk runs (with their results) and those they asked for; the
          lab and the ultrasound add a test of their own desk (a patient who came straight to them) */}
      {deskView && data && showDeskTests && (
        <>
          <CardBody className="border-border gap-2 border-t">
            {deskHead(
              <FlaskConical size={16} aria-hidden="true" className="text-primary flex-none" />,
              t('deskPart.tests'),
              mayDeskTest && (
                <Button
                  size="sm"
                  variant={mode === 'test' ? 'primary' : 'default'}
                  onClick={() => {
                    setMode(mode === 'test' ? null : 'test')
                    setMsgStep('tests')
                  }}
                >
                  <Plus size={14} aria-hidden="true" />
                  {t('deskPart.addTest')}
                </Button>
              ),
            )}
            {mode === 'test' && mayDeskTest && testForm}
            {deskMsgAt === 'tests' && messages}
            {data.orders.length === 0 && mode !== 'test' && (
              <EmptyNote>{t('deskPart.noTests')}</EmptyNote>
            )}
          </CardBody>
          {data.orders.map(renderOrder)}
        </>
      )}
      {/* the medicines of the person's desk: the pharmacy's to hand over, those given here */}
      {deskView && data && data.prescriptions.length > 0 && (
        <>
          <CardBody className="border-border border-t">
            {deskHead(
              <Pill size={16} aria-hidden="true" className="text-primary flex-none" />,
              t('sixSteps.prescriptions'),
            )}
          </CardBody>
          {data.prescriptions.map(renderRx)}
        </>
      )}
      {/* a diagnosis the person wrote before 0197 (the old tab): still theirs to read and correct */}
      {deskView && data && deskDiagnoses.length > 0 && (
        <>
          <CardBody className="border-border border-t">
            {deskHead(
              <Stethoscope size={16} aria-hidden="true" className="text-primary flex-none" />,
              t('deskPart.myDiagnoses'),
            )}
          </CardBody>
          {deskDiagnoses.map(renderDx)}
        </>
      )}
      {deskView && data && deskEmpty && (
        <CardBody className="border-border border-t">
          <EmptyNote>{t('deskPart.empty')}</EmptyNote>
        </CardBody>
      )}

      {(stepper ? msgStep === 'finish' : deskMsgAt === 'finish') && hasMessages && (
        <CardBody className="border-border border-t">{messages}</CardBody>
      )}
      {(!stepper || step === STEP_KEYS.length) && finishBar}
    </Card>
  )
}
