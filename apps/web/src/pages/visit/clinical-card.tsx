import { useState, type FormEvent } from 'react'
import {
  CheckCircle2,
  ClipboardList,
  FlaskConical,
  Pill,
  Plus,
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
import { cn } from '@/lib/utils'

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
}
const emptyLine = (): RxLine => ({
  item: '',
  quantity: '',
  dose: '',
  route: 'oral',
  frequency: '',
  days: '',
  instructions: '',
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
  onDone,
  onError,
}: {
  encounterId: string
  user: StaffUser
  onDone: (m: string) => void
  onError: (m: string | null) => void
}) {
  const { t, i18n } = useTranslation()
  const { data, error } = useVisitClinical(encounterId)
  const actions = useClinicalActions(encounterId)
  const { data: items = [] } = useItems()
  const { data: treatments = [] } = useTreatments(true)
  const tests = treatments.filter((x) => x.group === 'lab' || x.group === 'imaging')
  const clinician = user.role === 'doctor' || user.role === 'nurse' || user.role === 'manager'
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
  const [order, setOrder] = useState({ service: '', reason: '' })
  const [localError, setLocalError] = useState<string | null>(null)

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
          })
        }
        setRx([emptyLine()])
      },
      t('clinical.rxSaved', { count: prepared.length }),
    )
  }
  const submitOrder = (e: FormEvent) => {
    e.preventDefault()
    const s = tests.find((x) => x.id === order.service)
    if (!s) return setLocalError(t('clinical.errors.test'))
    void run(
      () =>
        actions.orderTest
          .mutateAsync({ serviceId: s.id, name: s.nameEn, group: s.group, reason: order.reason })
          .then(() => setOrder({ service: '', reason: '' })),
      t('clinical.testSaved'),
    )
  }
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
      disabled={!clinician}
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
        {data?.patient?.bloodGroup && (
          <Badge tone="grey" dot={false}>
            {t('file.fields.blood_group')} {data.patient.bloodGroup}
          </Badge>
        )}
      </CardHeader>
      {data?.patient?.allergies && (
        <CardBody className="bg-red-bg text-red border-border border-b py-2 text-[13px] font-semibold">
          ⚠ {t('file.allergiesLabel')}: {data.patient.allergies}
        </CardBody>
      )}
      <CardBody className="gap-3">
        {error && <p className={errorBox}>{error.message}</p>}
        <div className="flex flex-wrap gap-2">
          {tabBtn('note', t('clinical.addNote'), <ClipboardList size={14} aria-hidden="true" />)}
          {tabBtn('dx', t('clinical.addDx'), <Stethoscope size={14} aria-hidden="true" />)}
          {tabBtn('rx', t('clinical.addRx'), <Pill size={14} aria-hidden="true" />)}
          {tabBtn('test', t('clinical.addTest'), <FlaskConical size={14} aria-hidden="true" />)}
        </div>
        {!clinician && <p className="text-ink-3 m-0 text-xs">{t('clinical.readOnly')}</p>}

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
          </form>
        )}
        {mode === 'rx' && (
          <form onSubmit={submitRx} className="flex flex-col gap-3">
            <p className="text-ink-3 m-0 text-xs">{t('clinical.rxHint')}</p>
            {rx.map((line, i) => (
              <fieldset
                key={i}
                className="border-border bg-hover/40 m-0 flex flex-col gap-3 rounded-xl border p-3"
              >
                <legend className="text-ink-2 px-1 text-xs font-bold">
                  {t('clinical.medicineN', { n: i + 1 })}
                </legend>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]">
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
                  <Button
                    variant="ghost"
                    size="sm"
                    className="self-end"
                    disabled={rx.length === 1}
                    onClick={() => setRx((lines) => lines.filter((_, j) => j !== i))}
                    aria-label={t('clinical.removeMedicine')}
                    title={t('clinical.removeMedicine')}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </Button>
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
          <form
            onSubmit={submitOrder}
            className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_2fr_auto]"
          >
            <Select
              label={t('clinical.test')}
              value={order.service}
              onChange={(e) => setOrder({ ...order, service: e.target.value })}
              required
            >
              <option value="">{t('clinical.pickTest')}</option>
              {tests.map((s) => (
                <option key={s.id} value={s.id}>
                  {treatmentName(s, i18n.language)} ·{' '}
                  {s.group === 'imaging'
                    ? t('register.stations.ultrasound')
                    : t('register.stations.laboratory')}
                </option>
              ))}
            </Select>
            <Field
              label={t('clinical.reason')}
              value={order.reason}
              onChange={(e) => setOrder({ ...order, reason: e.target.value })}
            />
            <Button
              type="submit"
              variant="primary"
              className="self-end"
              loading={actions.orderTest.isPending}
            >
              {t('clinical.saveTest')}
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
            <Badge tone={r.dispensed ? 'green' : 'yellow'} dot={false}>
              {t(r.dispensed ? 'clinical.dispensed' : 'clinical.toDispense')}
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
              {o.category === 'imaging'
                ? t('register.stations.ultrasound')
                : t('register.stations.laboratory')}
            </Badge>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">
                {o.test}{' '}
                <span className="text-ink-3 text-xs">· {t(`clinical.status.${o.status}`)}</span>
              </span>
              <span className="text-ink-3 block text-xs">
                {[o.reason, o.result?.impression ?? o.result?.findings].filter(Boolean).join(' · ')}
              </span>
            </span>
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
