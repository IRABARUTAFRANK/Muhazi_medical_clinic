import { useState, type FormEvent } from 'react'
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
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime, type StaffUser } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { treatmentName, useTreatments } from '@/lib/api/catalogue'
import { useClinicalActions, useItems, useVisitClinical, type Item } from '@/lib/api/patients'
import { useClinicInfo } from '@/lib/api/public'
import { stationFor, type Station } from '@/lib/api/visits'
import { openPrescription, type RxDocMedicine } from '@/lib/prescription-doc'
import { roleLabel } from '@/lib/roles'
import { cn } from '@/lib/utils'
import { useCan } from '@/lib/api/permissions'
import { openMedicalReport } from '@/lib/medical-report'
import { useLetterhead, useMedicalReportLabels } from '@/lib/report-parts'

const errorBox = 'bg-red-bg text-red m-0 rounded-xl px-3 py-2 text-[13px] font-semibold'
const ROUTES = ['oral', 'IV', 'IM', 'SC', 'topical', 'rectal', 'inhaled', 'other']
/** Standard prescription frequencies (stored as the usual code: OD, BD, TDS…). */
const FREQUENCIES = ['OD', 'BD', 'TDS', 'QID', 'Q8H', 'Q6H', 'NOCTE', 'PRN', 'STAT'] as const
interface RxLine {
  item: string
  quantity: string
  dose: string
  route: string
  frequency: string
  days: string
  instructions: string
  /** Patient collects it at the pharmacy, or the prescriber gives it here from the room. */
  supply: 'pharmacy' | 'room'
}
const emptyLine = (): RxLine => ({
  item: '',
  quantity: '',
  dose: '',
  route: 'oral',
  frequency: '',
  days: '',
  instructions: '',
  supply: 'pharmacy',
})
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
  onDone,
  onError,
}: {
  encounterId: string
  user: StaffUser
  /** The desk this person works at for this patient (tests send the patient back here). */
  station?: Station
  /** For the printed prescription. */
  patient?: { name: string; fileNumber: string; ageSex: string; weight?: string | null }
  /** For the medical report: the visit's vital signs and what was charged. */
  report?: { vitals: { label: string; value: string }[]; treatments: string[]; since?: string }
  /** Open the medical report panel at once. */
  openReport?: boolean
  /** The patient is with someone else: read only, with who holds them. */
  lockedNote?: string | null
  /** A finished visit: shown read-only (everything stays in the patient file). */
  closed?: boolean
  onDone: (m: string) => void
  onError: (m: string | null) => void
}) {
  const { t, i18n } = useTranslation()
  const { data, error } = useVisitClinical(encounterId)
  const actions = useClinicalActions(encounterId)
  const { data: items = [] } = useItems()
  const { data: treatments = [] } = useTreatments(true)
  // Orderable treatments, grouped by the desk that carries them out.
  const tests = treatments.filter((x) => x.orderStation)
  const desks = [...new Set(tests.map((x) => x.orderStation!))]
  const can = useCan(user)
  const readOnly = closed || !!lockedNote
  const clinician =
    (user.role === 'doctor' || user.role === 'nurse' || user.role === 'manager') &&
    !readOnly &&
    can('clinical.write')
  // The lab / ultrasound may register the tests of their own desk (a patient who came straight
  // to them); notes, diagnoses and prescriptions stay with the clinicians.
  const deskStaff = user.role === 'lab_tech' && !readOnly && can('orders.write')
  // Lab / ultrasound staff (and clinicians) record results; reception and the cashier do not.
  // (a doctor or nurse locked out of this patient does not write results on it)
  const canResult =
    !closed &&
    user.role !== 'receptionist' &&
    user.role !== 'cashier' &&
    user.role !== 'pharmacist' &&
    !(lockedNote && (user.role === 'doctor' || user.role === 'nurse'))
  // A verified result is corrected with a reason, also after the visit ended.
  const canCorrect =
    user.role === 'lab_tech' ||
    user.role === 'manager' ||
    ((user.role === 'doctor' || user.role === 'nurse') && !lockedNote)
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
  const setLine = (i: number, patch: Partial<RxLine>) =>
    setRx((lines) => lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const [order, setOrder] = useState({
    services: [] as string[],
    reason: '',
    send: true,
    urgent: false,
  })
  const [localError, setLocalError] = useState<string | null>(null)
  const { data: info } = useClinicInfo()

  const letterhead = useLetterhead()
  const reportLabels = useMedicalReportLabels()
  const [reporting, setReporting] = useState(openReport)
  const [comment, setComment] = useState('')
  const printReport = () => {
    if (!data || !patient) return
    const ats = [
      ...[...data.notes, ...data.diagnoses, ...data.prescriptions, ...data.orders].map((x) => x.at),
      ...(report?.since ? [report.since] : []),
    ]
    const first = ats.sort()[0]
    const ok = openMedicalReport(
      {
        kind: 'visit',
        clinic: letterhead,
        patient: {
          name: patient.name,
          fileNumber: patient.fileNumber,
          ageSex: patient.ageSex,
          allergies: data.patient?.allergies ?? null,
          bloodGroup: data.patient?.bloodGroup ?? null,
        },
        visits: [
          {
            date: formatDate(first ? new Date(first) : new Date()),
            doctor: data.diagnoses[0]?.by ?? data.notes[0]?.by ?? null,
            vitals: report?.vitals ?? [],
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
            medicines: data.prescriptions.map((r) => ({
              name: `${r.item} × ${r.quantity}`,
              how: [
                r.dose,
                r.route ? t(`clinical.routes.${r.route}`, { defaultValue: r.route }) : null,
                r.frequency
                  ? t(`clinical.frequencies.${r.frequency}`, { defaultValue: r.frequency })
                  : null,
                r.days ? t('clinical.forDays', { count: r.days }) : null,
                r.instructions,
              ]
                .filter(Boolean)
                .join(' · '),
            })),
          },
        ],
        comment: comment.trim() || null,
        author: { name: user.name, title: roleLabel(user, t) },
      },
      reportLabels,
    )
    if (!ok) setLocalError(t('report.popupBlocked'))
  }

  const printRx = () => {
    if (!data || !patient) return
    const toDoc = (r: (typeof data.prescriptions)[number]): RxDocMedicine => ({
      name: r.item,
      quantity: r.quantity,
      dose: r.dose,
      route: r.route ? t(`clinical.routes.${r.route}`, { defaultValue: r.route }) : null,
      frequency: r.frequency
        ? t(`clinical.frequencies.${r.frequency}`, { defaultValue: r.frequency })
        : null,
      days: r.days,
      instructions: r.instructions,
    })
    const profile = (info?.profile ?? {}) as Record<string, unknown> & {
      name?: string
      sector?: string
      district?: string
      province?: string
      country?: string
      phone?: string
      email?: string
    }
    const dx = data.diagnoses.find((d) => d.type === 'primary') ?? data.diagnoses[0]
    const at = data.prescriptions[0]?.at
    const ok = openPrescription(
      {
        number: `${patient.fileNumber}-${(at ?? new Date().toISOString()).slice(0, 10).replace(/-/g, '')}`,
        date: at ? new Date(at) : new Date(),
        clinic: {
          name: profile.name ?? 'Muhazi Medical Clinic',
          address: [profile.sector, profile.district, profile.province, profile.country]
            .filter(Boolean)
            .join(' · '),
          contacts: [profile.phone, profile.email].filter(Boolean).join(' · '),
          licences: [
            profile.moh_licence ? `${t('rxDoc.moh')} ${String(profile.moh_licence)}` : null,
            profile.tin ? `TIN ${String(profile.tin)}` : null,
          ]
            .filter(Boolean)
            .join(' · '),
          logoUrl: `${window.location.origin}/logo.jpg`,
        },
        patient: { ...patient, allergies: data.patient?.allergies ?? null },
        diagnosis: dx
          ? `${dx.text}${dx.icd10 ? ` (${dx.icd10})` : ''}${dx.provisional ? ` · ${t('clinical.provisional')}` : ''}`
          : null,
        medicines: data.prescriptions.filter((r) => r.supply !== 'room').map(toDoc),
        givenHere: data.prescriptions.filter((r) => r.supply === 'room').map(toDoc),
        // the doctor who wrote it, not whoever prints it
        prescriber: (() => {
          const by = data?.prescriptions.find((r) => r.supply !== 'room')?.by
          return by && by !== user.name
            ? { name: by, title: t('staff.roles.doctor') }
            : { name: user.name, title: roleLabel(user, t) }
        })(),
      },
      {
        title: t('rxDoc.title'),
        number: t('rxDoc.number'),
        date: t('rxDoc.date'),
        patient: t('rxDoc.patient'),
        file: t('rxDoc.file'),
        ageSex: t('rxDoc.ageSex'),
        weight: t('rxDoc.weight'),
        allergies: t('rxDoc.allergies'),
        none: t('rxDoc.none'),
        diagnosis: t('rxDoc.diagnosis'),
        medicines: t('rxDoc.medicines'),
        quantity: t('rxDoc.quantity'),
        forDays: (n) => t('clinical.forDays', { count: n }),
        givenHere: t('rxDoc.givenHere'),
        prescriber: t('rxDoc.prescriber'),
        signature: t('rxDoc.signature'),
        stamp: t('rxDoc.stamp'),
        validity: t('rxDoc.validity'),
        asWritten: t('rxDoc.asWritten'),
      },
    )
    if (!ok) setLocalError(t('report.popupBlocked'))
  }

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setLocalError(null)
    onError(null)
    try {
      await fn()
      setMode(null)
      onDone(done)
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e))
    }
  }
  const submitNote = (e: FormEvent) => {
    e.preventDefault()
    if (!note.trim()) return
    void run(
      () => actions.addNote.mutateAsync(note).then(() => setNote('')),
      t('clinical.noteSaved'),
    )
  }
  const submitDx = (e: FormEvent) => {
    e.preventDefault()
    if (!dx.text.trim()) return
    void run(
      () =>
        actions.addDiagnosis
          .mutateAsync(dx)
          .then(() => setDx({ text: '', icd10: '', type: 'secondary', provisional: false })),
      t('clinical.dxSaved'),
    )
  }
  const submitRx = (e: FormEvent) => {
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
    void run(
      async () => {
        // One prescription per medicine, in the order written; the pharmacy sees them together.
        for (const { item, line, q } of prepared) {
          await actions.prescribe.mutateAsync({
            item,
            quantity: q,
            dose: line.dose,
            route: line.route,
            frequency: line.frequency,
            days: line.days ? Number(line.days) : undefined,
            instructions: line.instructions,
            supply: line.supply,
            station: stationFor(user),
          })
        }
        setRx([emptyLine()])
      },
      t('clinical.rxSaved', { count: prepared.length }),
    )
  }
  const submitOrder = (e: FormEvent) => {
    e.preventDefault()
    const chosen = tests.filter((x) => order.services.includes(x.id))
    if (chosen.length === 0) return setLocalError(t('clinical.errors.test'))
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
  const finish = () => {
    if (!data?.diagnoses.some((d) => d.type === 'primary'))
      return setLocalError(t('clinical.errors.needPrimary'))
    if (!window.confirm(t('clinical.finishConfirm'))) return
    void run(() => actions.finishVisit.mutateAsync(), t('clinical.finished'))
  }

  const tabBtn = (k: NonNullable<typeof mode>, label: string, icon: React.ReactNode) => (
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
          {patient && (data?.prescriptions.length ?? 0) > 0 && (
            <Button size="sm" onClick={printRx} title={t('rxDoc.printHint')}>
              <Printer size={14} aria-hidden="true" />
              {t('rxDoc.print')}
            </Button>
          )}
        </span>
      </CardHeader>
      {reporting && patient && data && (
        <CardBody className="bg-primary-tint/40 border-border anim-enter gap-2 border-b">
          <p className="m-0 text-[14px] font-bold">{t('medReport.panelTitle')}</p>
          <p className="text-ink-2 m-0 text-[13px]">{t('medReport.panelLead')}</p>
          <label className="text-ink-2 flex flex-col gap-1.5 text-[13px] font-semibold">
            {t('medReport.commentLabel')}
            <textarea
              rows={3}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={t('medReport.commentPh')}
              className="border-border bg-card text-ink focus:border-primary rounded-lg border px-3 py-2 text-[14px] font-normal outline-none"
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
          <p className="bg-green-bg text-green m-0 rounded-lg px-3 py-2 text-[13px] font-semibold">
            {t('clinical.closedNote')}
          </p>
        )}
        {lockedNote && !closed && (
          <p className="bg-violet-bg text-violet m-0 rounded-lg px-3 py-2 text-[13px] font-semibold">
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

        {mode === 'note' && (
          <form onSubmit={submitNote} className="flex flex-col gap-2">
            <label className="text-ink-2 flex flex-col gap-1.5 text-[13px] font-semibold">
              {t('clinical.note')}
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={4}
                placeholder={t('clinical.notePh')}
                className="border-border bg-card text-ink focus:border-primary focus:ring-primary-tint rounded-lg border px-3 py-2 text-[15px] font-normal outline-none focus:ring-[3px]"
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
        )}
        {mode === 'dx' && (
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
              <label className="flex min-h-11 items-center gap-2 text-[13px] font-semibold">
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
        )}
        {mode === 'rx' && (
          <form onSubmit={submitRx} className="flex flex-col gap-3">
            <p className="text-ink-3 m-0 text-xs">{t('clinical.rxHint')}</p>
            {rx.map((line, i) => (
              <fieldset
                key={i}
                className="border-border bg-hover/40 m-0 flex min-w-0 flex-col gap-3 rounded-xl border p-3"
              >
                <legend className="text-ink-2 px-1 text-xs font-bold">
                  {t('clinical.medicineN', { n: i + 1 })}
                </legend>
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <Select
                    label={t('clinical.medicine')}
                    value={line.item}
                    onChange={(e) => setLine(i, { item: e.target.value })}
                    wrapperClassName="col-span-2"
                    required
                  >
                    <option value="">{t('clinical.pickMedicine')}</option>
                    {items.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.name} {it.strength ?? ''} {it.form ? `· ${it.form}` : ''}
                      </option>
                    ))}
                  </Select>
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
                    {(['pharmacy', 'room'] as const).map((k) => (
                      <button
                        key={k}
                        type="button"
                        role="radio"
                        aria-checked={line.supply === k}
                        onClick={() => setLine(i, { supply: k })}
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
        )}
        {mode === 'test' && (
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
            {tests.length === 0 && (
              <p className="text-ink-3 m-0 text-[13px]">{t('clinical.noTests')}</p>
            )}
            <Field
              label={t('clinical.reason')}
              value={order.reason}
              onChange={(e) => setOrder({ ...order, reason: e.target.value })}
              placeholder={t('clinical.reasonPh')}
            />
            <label className="flex min-h-11 items-center gap-2 text-[13px] font-semibold">
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
        )}
        {localError && (
          <p role="alert" className={errorBox}>
            {localError}
          </p>
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
            <p className="text-ink-3 m-0 text-[13px]">{t('clinical.empty')}</p>
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
        data.prescriptions.map((r) => (
          <Row key={r.id} className="gap-3 py-2">
            <Badge
              tone={
                r.supply === 'room'
                  ? 'blue'
                  : r.notGivenAt
                    ? 'red'
                    : r.dispensed
                      ? 'green'
                      : 'yellow'
              }
              dot={false}
            >
              {r.supply === 'room'
                ? t('clinical.givenHere')
                : r.notGivenAt
                  ? t('clinical.notGiven')
                  : t(r.dispensed ? 'clinical.dispensed' : 'clinical.toDispense')}
            </Badge>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">
                {r.item} × {r.quantity}
              </span>
              <span className="text-ink-3 block text-xs">
                {[
                  r.dose,
                  r.route,
                  r.frequency,
                  r.days ? t('clinical.forDays', { count: r.days }) : null,
                  r.instructions,
                  r.supply === 'room' && r.givenBy
                    ? t('clinical.givenBy', { name: r.givenBy })
                    : null,
                  r.notGivenReason ? t('clinical.notGivenWhy', { reason: r.notGivenReason }) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
          </Row>
        ))}
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
              {o.result && (
                <span className="bg-green-bg/60 mt-1 block rounded-lg px-2.5 py-1.5 text-[13px]">
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
                <form
                  className="mt-2 flex flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
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
                      className="border-border bg-card rounded-lg border px-2.5 py-2 text-[14px] font-normal"
                      value={result.findings}
                      onChange={(e) => setResult({ ...result, findings: e.target.value })}
                    />
                  </label>
                  <label className="text-ink-2 flex flex-col gap-1 text-[13px] font-semibold">
                    {t('clinical.impression')}
                    <input
                      className="border-border bg-card h-10 rounded-lg border px-2.5 text-[14px] font-normal"
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
                        className="border-border bg-card h-10 rounded-lg border px-2.5 text-[14px] font-normal"
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
              )}
            </span>
            {(o.result?.verified ? canCorrect : canResult) &&
              resultFor !== o.id &&
              o.status !== 'cancelled' &&
              // a nurse writes the result of a desk order (Nursing…), the lab its own tests
              (user.role !== 'nurse' ||
                !['laboratory', 'ultrasound'].includes(o.station ?? 'laboratory')) && (
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
          <Button variant="primary" onClick={finish} loading={actions.finishVisit.isPending}>
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
