import { useEffect, useState, type FormEvent } from 'react'
import { AlertTriangle, UserPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { StaffLink } from '@/components/staff/staff-link'
import { setNoNationalId, useFindDuplicates, type NoIdReason } from '@/lib/api/patients'
import { useVisitActions, type Sex } from '@/lib/api/visits'
import { useConfirm } from '@/lib/confirm'

const SEXES: readonly Sex[] = ['female', 'male', 'other', 'unknown']

/*
 * A new patient file. Register first, then send: on the Register page the file is made and
 * handed to `onRegistered`, and the page then asks where the patient goes (or "only the file
 * for now"). With `fileOnly` (a booking for a later day) the file is handed back and Cancel
 * closes the form.
 */
export function NewPatientForm({
  emergency = false,
  onRegistered,
  describe = (e) => (e instanceof Error ? e.message : String(e)),
  nurse = false,
  fileOnly,
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
  /** Prefilled from a booking request (name and phone the person gave). */
  initial?: { surname?: string; givenNames?: string; phone?: string }
}) {
  const { t } = useTranslation()
  const actions = useVisitActions()
  const [surname, setSurname] = useState(initial?.surname ?? '')
  const [givenNames, setGivenNames] = useState(initial?.givenNames ?? '')
  const [sex, setSex] = useState<Sex>('unknown')
  const [birthDate, setBirthDate] = useState('')
  const [age, setAge] = useState('')
  const [phone, setPhone] = useState(initial?.phone ?? '')
  const [nationalId, setNationalId] = useState('')
  const [noId, setNoId] = useState<NoIdReason | ''>('')
  const [sector, setSector] = useState('')
  const [error, setError] = useState<string | null>(null)
  const confirm = useConfirm()
  // Once the names and a phone (or ID) are typed, the files that may be this person's already
  // (a pause after typing, so the database is not asked at every key).
  const typed = useDebounced({
    surname,
    givenNames,
    phone,
    nationalId: noId ? '' : nationalId,
    birthDate,
  })
  const { data: duplicates = [] } = useFindDuplicates(typed)

  const reset = () => {
    setSurname('')
    setGivenNames('')
    setSex('unknown')
    setBirthDate('')
    setAge('')
    setPhone('')
    setNationalId('')
    setNoId('')
    setSector('')
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (nationalId && nationalId.replace(/\D/g, '').length !== 16)
      return setError(t('register.errors.nationalIdFormat'))
    const patient = {
      surname,
      givenNames,
      sex,
      birthDate: birthDate || undefined,
      ageYears: !birthDate && age ? Number(age) : undefined,
      phone: phone || undefined,
      nationalId: noId ? undefined : nationalId || undefined,
      sector: sector || undefined,
    }
    if (
      !(await confirm({
        title: t('confirm.visit.newFile', { name: `${surname.trim()} ${givenNames.trim()}` }),
        body: t('confirm.visit.newFileBody'),
        confirmLabel: t('confirm.visit.newFileYes'),
      }))
    )
      return
    try {
      const f = await actions.registerFile.mutateAsync(patient)
      // A child or someone without an ID: say why, so the file is not flagged as incomplete.
      if (noId) await setNoNationalId(f.patientId, noId)
      const saved = { ...f, name: `${surname.trim()} ${givenNames.trim()}` }
      if (fileOnly) return fileOnly.onSaved(saved)
      reset()
      onRegistered?.(saved)
    } catch (err) {
      setError(describe(err))
    }
  }

  return (
    <Card className={fileOnly ? 'border-primary anim-enter' : undefined}>
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          <UserPlus size={16} aria-hidden="true" />
          {t(fileOnly ? 'register.fileOnly.title' : 'register.newPatient')}
        </span>
        {fileOnly && (
          <Button size="sm" variant="ghost" onClick={fileOnly.onCancel}>
            {t('common.close')}
          </Button>
        )}
      </CardHeader>
      <form onSubmit={submit}>
        <CardBody className="gap-3">
          <p className="text-ink-2 bg-primary-tint/60 m-0 rounded-md px-3 py-2 text-xs">
            {t(
              fileOnly
                ? 'register.fileOnly.hint'
                : nurse
                  ? 'files.nurseHint'
                  : 'files.receptionHint',
            )}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label={t('register.surname')}
              value={surname}
              onChange={(e) => setSurname(e.target.value)}
              autoComplete="off"
              required
            />
            <Field
              label={t('register.givenNames')}
              value={givenNames}
              onChange={(e) => setGivenNames(e.target.value)}
              autoComplete="off"
              required
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Select
              label={t('register.sex')}
              value={sex}
              onChange={(e) => setSex(e.target.value as Sex)}
            >
              {SEXES.map((s) => (
                <option key={s} value={s}>
                  {t(`register.sexes.${s}`)}
                </option>
              ))}
            </Select>
            <Field
              label={t('register.birthDate')}
              type="date"
              value={birthDate}
              onChange={(e) => {
                // A date of birth wins: it fills the age; typing an age clears the date.
                setBirthDate(e.target.value)
                setAge(e.target.value ? String(yearsSince(e.target.value)) : '')
              }}
              max={new Date().toISOString().slice(0, 10)}
            />
            <Field
              label={t('register.ageYears')}
              inputMode="numeric"
              value={age}
              onChange={(e) => {
                setAge(e.target.value.replace(/\D/g, '').slice(0, 3))
                setBirthDate('')
              }}
              placeholder={t('register.agePh')}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field
              label={t('register.phone')}
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="07xx xxx xxx"
            />
            <Field
              label={t('register.nationalId')}
              inputMode="numeric"
              disabled={!!noId}
              value={noId ? '' : nationalId}
              onChange={(e) => setNationalId(e.target.value.replace(/\D/g, '').slice(0, 16))}
              placeholder="1 1990 8 …"
            />
            <Field
              label={t('register.sector')}
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              placeholder="Kiramuruzi"
            />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Select
              label={t('register.noId.label')}
              value={noId}
              onChange={(e) => setNoId(e.target.value as NoIdReason | '')}
              wrapperClassName="w-72"
            >
              <option value="">{t('register.noId.has')}</option>
              <option value="child">{t('register.noId.child')}</option>
              <option value="not_issued">{t('register.noId.not_issued')}</option>
              <option value="foreigner">{t('register.noId.foreigner')}</option>
            </Select>
            {noId === 'child' && (
              <p className="text-ink-3 m-0 max-w-[460px] pb-2 text-[13px]">
                {t('register.noId.childHint')}
              </p>
            )}
          </div>
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
              disabled={actions.registerFile.isPending}
            >
              {actions.registerFile.isPending
                ? t('register.submitting')
                : t(fileOnly ? 'register.fileOnly.submit' : 'register.submitFirst')}
            </Button>
            {fileOnly && (
              <Button type="button" variant="ghost" size="lg" onClick={fileOnly.onCancel}>
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

/** Whole years between a YYYY-MM-DD date and today. */
const yearsSince = (iso: string): number => {
  const b = new Date(iso)
  const n = new Date()
  let y = n.getFullYear() - b.getFullYear()
  if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) y -= 1
  return Math.max(0, y)
}
