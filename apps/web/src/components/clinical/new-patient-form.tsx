import { useEffect, useState, type FormEvent } from 'react'
import { AlertTriangle, CalendarCheck, UserPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { StaffLink } from '@/components/staff/staff-link'
import { useFindDuplicates } from '@/lib/api/patients'
import { useVisitActions, type Sex } from '@/lib/api/visits'
import { useConfirm } from '@/lib/confirm'
import {
  asFile,
  draftPayload,
  draftProblem,
  emptyDraft,
  requiredMissing,
  type PatientDraft,
} from '@/lib/patient-rules'
import { CoreFields, DetailFields, type SetDraft } from './patient-details-fields'
import { useFieldSettings, useMissingLabel } from './use-field-settings'

/*
 * A new patient file. Register first, then send: on the Register page the file is made and
 * handed to `onRegistered`, and the page then asks where the patient goes (or "only the file
 * for now"). With `fileOnly` (a booking for a later day) the file is handed back and Cancel
 * closes the form. With `arrival` (a booked patient who has no file yet) the form is handed to
 * the arrival, which makes the file and opens the visit together.
 *
 * The fields follow Settings › Patient fields (0108): hidden ones are left out, required ones
 * block saving with the list of what is missing (not for an emergency, nor the nurse's quick
 * file: those land in "Files to complete"), the clinic's own fields come in the manager's order.
 */
export function NewPatientForm({
  emergency = false,
  onRegistered,
  describe = (e) => (e instanceof Error ? e.message : String(e)),
  nurse = false,
  fileOnly,
  arrival,
  initial,
}: {
  emergency?: boolean
  /** Register page: the file is made; where the patient goes is chosen next. */
  onRegistered?: (r: { patientId: string; fileNumber: string; name: string }) => void
  describe?: (e: unknown) => string
  /** The nurse registers what she can; reception completes phone, ID and address later. */
  nurse?: boolean
  /** Only the file, no visit (a booking): the new file is handed back; Cancel closes the form. */
  fileOnly?: {
    onSaved: (r: { patientId: string; fileNumber: string; name: string }) => void
    onCancel: () => void
  }
  /** A booked patient without a file has arrived: the form goes with the arrival. */
  arrival?: {
    /** What the booking says: time, doctor, reason. */
    booking: string
    busy?: boolean
    onSubmit: (registration: Record<string, unknown>) => Promise<void>
    onCancel: () => void
  }
  /** Prefilled from a booking request (name and phone the person gave). */
  initial?: { surname?: string; givenNames?: string; phone?: string }
}) {
  const { t } = useTranslation()
  const actions = useVisitActions()
  const confirm = useConfirm()
  const { states, defs } = useFieldSettings()
  const missingLabel = useMissingLabel()
  const fresh = (): PatientDraft => ({
    ...emptyDraft(),
    surname: initial?.surname ?? '',
    given_names: initial?.givenNames ?? '',
    phone_1: initial?.phone ?? '',
  })
  const [draft, setDraft] = useState<PatientDraft>(fresh)
  const set: SetDraft = (k, v) => setDraft((d) => ({ ...d, [k]: v }))
  const setExtra = (k: string, v: string) =>
    setDraft((d) => ({ ...d, extra: { ...d.extra, [k]: v } }))
  const [error, setError] = useState<string | null>(null)
  // an emergency or the nurse's quick file: the required fields are completed later
  const quick = emergency || nurse
  // Once the names and a phone (or ID) are typed, the files that may be this person's already
  // (a pause after typing, so the database is not asked at every key).
  const typed = useDebounced({
    surname: draft.surname,
    givenNames: draft.given_names,
    phone: draft.phone_1,
    nationalId: draft.id_kind === 'national_id' ? draft.national_id : '',
    birthDate: draft.birth_date,
  })
  const { data: duplicates = [] } = useFindDuplicates(typed)
  const name = `${draft.surname.trim()} ${draft.given_names.trim()}`.trim()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    const problem = draftProblem(draft, states)
    if (problem) return setError(t(problem.key, problem.values))
    if (!quick) {
      const missing = requiredMissing(asFile(draft), states, defs, draft.age_years)
      if (missing.length > 0)
        return setError(
          t('patientFields.errors.required', { fields: missing.map(missingLabel).join(', ') }),
        )
    }
    const payload = draftPayload(draft, states)
    if (arrival) {
      if (
        !(await confirm({
          title: t('visitConfirm.titleRegister', { name }),
          body: `${t('visitConfirm.newFile')} ${t('visitConfirm.arrived')} ${t('visitConfirm.bill')}`,
          confirmLabel: t('visitConfirm.yesRegister'),
        }))
      )
        return
      try {
        await arrival.onSubmit(payload)
      } catch (err) {
        setError(describe(err))
      }
      return
    }
    if (
      !(await confirm({
        title: t('confirm.visit.newFile', { name }),
        body: t('confirm.visit.newFileBody'),
        confirmLabel: t('confirm.visit.newFileYes'),
      }))
    )
      return
    try {
      const f = await actions.registerFile.mutateAsync({
        surname: draft.surname,
        givenNames: draft.given_names,
        sex: (draft.sex || 'unknown') as Sex,
        birthDate: draft.birth_date || undefined,
        ageYears: !draft.birth_date && draft.age_years ? Number(draft.age_years) : undefined,
        phone: typeof payload.phone_1 === 'string' ? payload.phone_1 : undefined,
        nationalId: typeof payload.national_id === 'string' ? payload.national_id : undefined,
        sector: typeof payload.sector === 'string' ? payload.sector : undefined,
        more: payload,
        emergency,
      })
      const saved = { ...f, name }
      if (fileOnly) return fileOnly.onSaved(saved)
      setDraft(fresh())
      onRegistered?.(saved)
    } catch (err) {
      setError(describe(err))
    }
  }

  const busy = arrival ? !!arrival.busy : actions.registerFile.isPending
  const onCancel = arrival?.onCancel ?? fileOnly?.onCancel
  return (
    <Card className={fileOnly || arrival ? 'border-primary anim-enter' : undefined}>
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          {arrival ? (
            <CalendarCheck size={16} aria-hidden="true" />
          ) : (
            <UserPlus size={16} aria-hidden="true" />
          )}
          {arrival
            ? t('patientFields.arrival.title', { name: name || '…' })
            : t(fileOnly ? 'register.fileOnly.title' : 'register.newPatient')}
        </span>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t('common.close')}
          </Button>
        )}
      </CardHeader>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <CardBody className="gap-3">
          <p className="text-ink-2 bg-primary-tint/60 m-0 rounded-md px-3 py-2 text-xs">
            {arrival
              ? t('patientFields.arrival.hint', { booking: arrival.booking })
              : t(
                  fileOnly
                    ? 'register.fileOnly.hint'
                    : nurse
                      ? 'files.nurseHint'
                      : 'files.receptionHint',
                )}
          </p>
          <CoreFields draft={draft} set={set} />
          <DetailFields
            draft={draft}
            set={set}
            setExtra={setExtra}
            states={states}
            defs={defs}
            mode="register"
          />
          {quick ? (
            <p className="text-ink-3 m-0 text-[12px]">{t('patientFields.quickHint')}</p>
          ) : (
            <p className="text-ink-3 m-0 text-[12px]">
              <span aria-hidden="true" className="text-red font-semibold">
                *
              </span>{' '}
              {t('patientFields.requiredHint')}
            </p>
          )}
          {/* a possible duplicate never blocks: the file may still be registered */}
          {duplicates.length > 0 && (
            <div className="bg-amber-bg text-amber flex flex-col gap-2 rounded-md px-3 py-2 text-[13px] font-semibold">
              {duplicates.map((d) => (
                <span key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <AlertTriangle size={16} aria-hidden="true" className="flex-none" />
                  <span className="min-w-0 flex-1">
                    {t('register.duplicate.line', { name: d.name, file: d.fileNumber })}
                  </span>
                  <StaffLink
                    to="/app/patient"
                    search={{ id: d.id }}
                    className={buttonVariants({ size: 'sm' })}
                  >
                    {t('patients.openFile')}
                  </StaffLink>
                </span>
              ))}
            </div>
          )}
          {error && (
            <p
              role="alert"
              className="bg-red-bg text-red border-red/30 m-0 rounded-md border px-3 py-2 text-[13px] font-semibold"
            >
              {error}
            </p>
          )}
          <span className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant={emergency ? 'danger' : 'primary'}
              size="lg"
              disabled={busy}
            >
              {busy
                ? t('register.submitting')
                : arrival
                  ? t('patientFields.arrival.submit')
                  : t(fileOnly ? 'register.fileOnly.submit' : 'register.submitFirst')}
            </Button>
            {onCancel && (
              <Button type="button" variant="ghost" size="lg" onClick={onCancel}>
                {t('staff.form.cancel')}
              </Button>
            )}
          </span>
        </CardBody>
      </form>
    </Card>
  )
}

/** The value as it was half a second ago (the typing has paused). */
function useDebounced<T>(value: T, ms = 500): T {
  const [settled, setSettled] = useState(value)
  const key = JSON.stringify(value)
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new object each render: compare by content
  }, [key, ms])
  return settled
}
