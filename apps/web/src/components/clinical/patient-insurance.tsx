import { useState } from 'react'
import { Pencil, Save, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { useInsurers } from '@/lib/api/catalogue'
import { usePatientInsurance, useSavePatientInsurance } from '@/lib/api/patient-insurance'
import { useInsuranceEnabled } from '@/lib/api/settings'

/** Who pays: the insurer ('' = a private patient) and the member number. */
export interface PayChoice {
  payerId: string
  memberNumber: string
}

/**
 * The insurer a patient is treated under and the member number (0139): a private patient pays the
 * clinic's prices; under an insurer, every visit takes that insurer's prices and coverage.
 */
export function PayFields({
  value,
  onChange,
  disabled,
}: {
  value: PayChoice
  onChange: (v: PayChoice) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const { data: insurers = [] } = useInsurers(true)
  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,220px)]">
      <Select
        label={t('patientInsurance.who')}
        value={value.payerId}
        disabled={disabled}
        onChange={(e) => onChange({ ...value, payerId: e.target.value })}
      >
        <option value="">{t('patientInsurance.private')}</option>
        {insurers.map((i) => (
          <option key={i.id} value={i.id}>
            {t('patientInsurance.under', { name: i.name, pct: i.coveragePct })}
          </option>
        ))}
      </Select>
      {value.payerId && (
        <Field
          label={t('patientInsurance.member')}
          value={value.memberNumber}
          maxLength={60}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, memberNumber: e.target.value })}
        />
      )}
    </div>
  )
}

/**
 * The patient's file: the insurer the patient is treated under, changed here by reception, the
 * cashier or the manager (only when the clinic works with insurers).
 */
export function PatientInsuranceCard({
  patientId,
  mayEdit,
}: {
  patientId: string
  mayEdit: boolean
}) {
  const { t } = useTranslation()
  const insurance = useInsuranceEnabled()
  const { data: current, isLoading } = usePatientInsurance(insurance ? patientId : null)
  const save = useSavePatientInsurance()
  const [editing, setEditing] = useState<PayChoice | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  if (!insurance) return null

  const submit = async () => {
    if (!editing) return
    setError(null)
    try {
      const r = await save.mutateAsync({
        patientId,
        payerId: editing.payerId || null,
        memberNumber: editing.memberNumber,
      })
      setEditing(null)
      setDone(
        r ? t('patientInsurance.saved', { name: r.payer }) : t('patientInsurance.savedPrivate'),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Card className="anim-enter">
      <CardHeader icon={ShieldCheck} hue="navy">
        <span className="min-w-0 flex-1">{t('patientInsurance.title')}</span>
        {mayEdit && !editing && (
          <Button
            size="sm"
            variant="tint-blue"
            onClick={() => {
              setDone(null)
              setEditing({
                payerId: current?.payerId ?? '',
                memberNumber: current?.memberNumber ?? '',
              })
            }}
          >
            <Pencil size={14} aria-hidden="true" />
            {t('patientInsurance.change')}
          </Button>
        )}
      </CardHeader>
      <CardBody className="gap-2">
        {editing ? (
          <>
            <PayFields value={editing} onChange={setEditing} disabled={save.isPending} />
            <p className="text-ink-3 m-0 text-[13px]">{t('patientInsurance.hint')}</p>
            {error && (
              <p
                role="alert"
                className="border-red/30 bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[14px] font-medium"
              >
                {error}
              </p>
            )}
            <span className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="primary"
                loading={save.isPending}
                onClick={() => void submit()}
              >
                <Save size={14} aria-hidden="true" />
                {t('patientInsurance.save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                {t('staff.form.cancel')}
              </Button>
            </span>
          </>
        ) : isLoading ? (
          <span className="text-ink-3 text-[14px]">…</span>
        ) : current ? (
          <span className="flex flex-wrap items-center gap-2 text-[15px]">
            <Badge tone="blue">{current.payer}</Badge>
            {current.memberNumber && (
              <span className="text-ink-2">
                {t('patientInsurance.memberIs', { no: current.memberNumber })}
              </span>
            )}
            <span className="text-ink-3 basis-full text-[13px]">
              {t('patientInsurance.everyVisit')}
            </span>
          </span>
        ) : (
          <span className="text-ink-2 text-[15px]">{t('patientInsurance.none')}</span>
        )}
        {done && <p className="text-green m-0 text-[14px] font-medium">{done}</p>}
      </CardBody>
    </Card>
  )
}
