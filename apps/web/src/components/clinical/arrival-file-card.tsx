import { useState } from 'react'
import { FolderCheck, Search, UserPlus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Reveal } from '@/components/ui/reveal'
import { useDeskOps, type DayAppointment } from '@/lib/api/desk-ops'
import { useFindPatients, type PatientHit } from '@/lib/api/visits'
import { NewPatientForm } from './new-patient-form'
import { StartVisitConfirm } from './start-visit-confirm'

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * A booked patient who has no file yet has arrived (a website request with a name and a phone).
 * First: "This patient already has a file": found by name, phone, file number or national ID and
 * used for the booking, so no second file is made. Else the registration form, prefilled from
 * the booking, with the clinic's required fields: the file is made only when it is complete, and
 * the arrival continues with it (the visit opens, the patient joins the queue).
 */
export function ArrivalFileCard({
  appt,
  desk,
  onArrived,
  onCancel,
}: {
  appt: DayAppointment
  /** The desk whose queue the patient joins (triage or the doctor's). */
  desk: string
  onArrived: (v: {
    encounterId: string
    existing: boolean
    fileNumber: string | null
    newFile: boolean
    name: string
  }) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const ops = useDeskOps()
  const [step, setStep] = useState<'find' | 'new'>('find')
  const [query, setQuery] = useState(appt.name)
  const { data: hits = [], isFetching } = useFindPatients(query)
  const [chosen, setChosen] = useState<PatientHit | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [first = '', ...rest] = appt.name.trim().split(/\s+/)
  const booking = [appt.time, appt.doctor, appt.reason].filter(Boolean).join(' · ')

  const link = async (p: PatientHit) => {
    setError(null)
    try {
      const v = await ops.arrived.mutateAsync({ id: appt.id, patientId: p.id })
      onArrived({
        ...v,
        fileNumber: v.fileNumber ?? p.fileNumber,
        name: `${p.surname} ${p.givenNames}`,
      })
    } catch (e) {
      setError(describe(e))
    }
  }

  if (step === 'new')
    return (
      <Reveal focus block="nearest" className="basis-full">
        <NewPatientForm
          initial={{ surname: first, givenNames: rest.join(' '), phone: appt.phone ?? '' }}
          arrival={{
            booking,
            busy: ops.arrived.isPending,
            onSubmit: async (registration) => {
              const v = await ops.arrived.mutateAsync({ id: appt.id, registration })
              const name = `${String(registration.surname ?? '')} ${String(registration.given_names ?? '')}`
              onArrived({ ...v, name: name.trim() })
            },
            onCancel: () => setStep('find'),
          }}
        />
      </Reveal>
    )

  return (
    <Reveal focus block="nearest" className="basis-full">
      <div className="border-primary/30 wash wash-teal rounded-lg2 flex flex-col gap-3 border p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-semibold">
              {t('patientFields.arrival.noFile', { name: appt.name })}
            </span>
            <span className="text-ink-2 block text-[13px]">
              {t('patientFields.arrival.findLead')}
            </span>
          </span>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            <X size={14} aria-hidden="true" />
            {t('staff.form.cancel')}
          </Button>
        </div>
        <Field
          label={
            <span className="inline-flex items-center gap-1.5">
              <Search size={14} aria-hidden="true" />
              {t('patientFields.arrival.search')}
            </span>
          }
          value={query}
          placeholder={t('register.searchPh')}
          onChange={(e) => {
            setQuery(e.target.value)
            setChosen(null)
          }}
          autoComplete="off"
        />
        {query.trim().length >= 2 && !isFetching && hits.length === 0 && (
          <p className="text-ink-3 m-0 text-[13px]">{t('patientFields.arrival.noMatch')}</p>
        )}
        {hits.length > 0 && (
          <div className="border-card-border bg-card shadow-card rounded-lg2 flex flex-col border">
            {hits.slice(0, 6).map((h) => (
              <div
                key={h.id}
                className="border-grid flex flex-wrap items-center gap-2 border-b px-3 py-2 text-[13px] last:border-b-0"
              >
                <span className="text-primary font-semibold tabular-nums">{h.fileNumber}</span>
                <span className="min-w-[120px] flex-1 font-semibold">
                  {h.surname} {h.givenNames}
                </span>
                <span className="text-ink-3 tabular-nums">
                  {[h.birthDate, h.phone].filter(Boolean).join(' · ')}
                </span>
                <Button
                  size="sm"
                  variant={chosen?.id === h.id ? 'default' : 'tint-blue'}
                  onClick={() => setChosen(h)}
                >
                  <FolderCheck size={14} aria-hidden="true" />
                  {t('patientFields.arrival.useFile')}
                </Button>
              </div>
            ))}
          </div>
        )}
        {chosen && (
          <StartVisitConfirm
            mode="arrival"
            name={`${chosen.surname} ${chosen.givenNames}`}
            fileNumber={chosen.fileNumber}
            desk={desk}
            busy={ops.arrived.isPending}
            onConfirm={() => void link(chosen)}
            onCancel={() => setChosen(null)}
          />
        )}
        {error && (
          <p
            role="alert"
            className="bg-red-bg text-red m-0 rounded-lg px-2.5 py-1.5 text-[13px] font-semibold"
          >
            {error}
          </p>
        )}
        <div className="border-grid flex flex-wrap items-center gap-2 border-t pt-3">
          <span className="text-ink-2 min-w-0 flex-1 text-[13px]">
            {t('patientFields.arrival.newLead')}
          </span>
          <Button size="sm" variant="primary" onClick={() => setStep('new')}>
            <UserPlus size={14} aria-hidden="true" />
            {t('patientFields.arrival.register')}
          </Button>
        </div>
      </div>
    </Reveal>
  )
}
