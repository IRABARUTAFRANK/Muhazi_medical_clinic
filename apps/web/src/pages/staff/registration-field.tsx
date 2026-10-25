import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { REGISTRATION_BODIES, registrationText, type DbRole } from '@/lib/api/staff'
import { cn } from '@/lib/utils'
import {
  OTHER,
  REGISTRATION_BODY_MAX,
  REGISTRATION_NO_MAX,
  resolvedBody,
  type RegistrationValue,
} from './registration'

/** "Professional registration no." with the council it was issued by, and how it will print. */
export function RegistrationField({
  role,
  value,
  onChange,
}: {
  role: DbRole
  value: RegistrationValue
  onChange: (v: RegistrationValue) => void
}) {
  const { t } = useTranslation()
  const hintId = useId()
  const printed = registrationText({
    registrationNo: value.no,
    registrationBody: resolvedBody(value),
  })
  const missing = role === 'doctor' && !value.no.trim()

  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label={t('staff.form.registrationNo')}
          value={value.no}
          placeholder={t('staff.form.registrationNoPh')}
          maxLength={REGISTRATION_NO_MAX}
          autoComplete="off"
          aria-describedby={hintId}
          onChange={(e) => onChange({ ...value, no: e.target.value })}
        />
        <Select
          label={t('staff.form.registrationBody')}
          value={value.body}
          onChange={(e) => onChange({ ...value, body: e.target.value })}
          disabled={!value.no.trim()}
        >
          <option value="">{t('staff.form.registrationBodyNone')}</option>
          {REGISTRATION_BODIES.map((b) => (
            <option key={b} value={b}>
              {t(`staff.form.registrationBodies.${b}`)}
            </option>
          ))}
          <option value={OTHER}>{t('staff.form.registrationBodies.other')}</option>
        </Select>
      </div>
      {value.body === OTHER && value.no.trim() && (
        <Field
          label={t('staff.form.registrationBodyOther')}
          value={value.otherBody}
          maxLength={REGISTRATION_BODY_MAX}
          autoComplete="off"
          onChange={(e) => onChange({ ...value, otherBody: e.target.value })}
        />
      )}
      <p
        id={hintId}
        className={cn('m-0 text-xs', missing ? 'text-amber font-semibold' : 'text-ink-3')}
      >
        {printed
          ? t('staff.form.registrationPrinted', { reg: printed })
          : t(missing ? 'staff.form.registrationDoctorHint' : 'staff.form.registrationHint')}
      </p>
    </fieldset>
  )
}
