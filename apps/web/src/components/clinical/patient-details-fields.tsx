import { useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Field, controlClass, labelClass } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { type PatientFieldDef } from '@/lib/api/patients'
import {
  BUILTIN_FIELDS,
  ID_KINDS,
  ID_NUMBER_MAX,
  ID_NUMBER_MIN,
  MAIN_FIELDS,
  MARITAL_STATUSES,
  NATIONAL_ID_LENGTH,
  PROVINCES,
  cleanIdNumber,
  groupNationalId,
  nationalIdDigits,
  type BuiltinField,
  type BuiltinStates,
  type IdKind,
  type PatientDraft,
} from '@/lib/patient-rules'
import { cn } from '@/lib/utils'

/** A label with a red star when the field is required. */
export function Req({ children, on }: { children: ReactNode; on?: boolean }) {
  // one element: the labels lay their children out in a column
  return (
    <span>
      {children}
      {on && (
        <span aria-hidden="true" className="text-red ml-0.5 font-semibold">
          *
        </span>
      )}
    </span>
  )
}

export type SetDraft = <K extends keyof PatientDraft>(k: K, v: PatientDraft[K]) => void

const SEXES = ['female', 'male', 'other', 'unknown'] as const

/** Surname, given names, sex and the date of birth or age: always shown, always required. */
export function CoreFields({
  draft,
  set,
  autoFocus,
}: {
  draft: PatientDraft
  set: SetDraft
  autoFocus?: boolean
}) {
  const { t } = useTranslation()
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label={<Req on>{t('register.surname')}</Req>}
          value={draft.surname}
          onChange={(e) => set('surname', e.target.value)}
          autoComplete="off"
          autoFocus={autoFocus}
          required
        />
        <Field
          label={<Req on>{t('register.givenNames')}</Req>}
          value={draft.given_names}
          onChange={(e) => set('given_names', e.target.value)}
          autoComplete="off"
          required
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Select
          label={<Req on>{t('register.sex')}</Req>}
          value={draft.sex}
          onChange={(e) => set('sex', e.target.value)}
          required
        >
          <option value="" disabled>
            {t('patientFields.choose')}
          </option>
          {SEXES.map((s) => (
            <option key={s} value={s}>
              {t(`register.sexes.${s}`)}
            </option>
          ))}
        </Select>
        <Field
          label={<Req on>{t('register.birthDate')}</Req>}
          type="date"
          value={draft.birth_date}
          onChange={(e) => {
            // a date of birth wins: it fills the age; typing an age clears the date
            set('birth_date', e.target.value)
            set('age_years', e.target.value ? String(yearsSince(e.target.value)) : '')
          }}
          max={new Date().toISOString().slice(0, 10)}
        />
        <Field
          label={t('register.ageYears')}
          inputMode="numeric"
          value={draft.age_years}
          onChange={(e) => {
            set('age_years', e.target.value.replace(/\D/g, '').slice(0, 3))
            set('birth_date', '')
          }}
          placeholder={t('register.agePh')}
        />
      </div>
    </>
  )
}

/**
 * The ID document: its type and number. A national ID is exactly 16 digits (spaces of a pasted
 * number dropped, a live count, shown grouped once complete); a passport or another ID keeps its
 * own rule (6 to 20 letters or digits); or why there is none.
 */
export function IdField({
  draft,
  set,
  required,
}: {
  draft: PatientDraft
  set: SetDraft
  required?: boolean
}) {
  const { t } = useTranslation()
  const [cut, setCut] = useState(false)
  const kind = draft.id_kind
  const national = kind === 'national_id'
  const hasNumber = national || kind === 'passport' || kind === 'other'
  const value = national ? draft.national_id : draft.id_number
  const n = value.length
  const complete = national ? n === NATIONAL_ID_LENGTH : n >= ID_NUMBER_MIN
  return (
    <div className="grid grid-cols-1 gap-3 sm:col-span-full sm:grid-cols-2">
      <Select
        label={<Req on={required}>{t('patientFields.id.kind')}</Req>}
        value={kind}
        onChange={(e) => {
          setCut(false)
          set('id_kind', e.target.value as IdKind)
        }}
      >
        {ID_KINDS.map((k) => (
          <option key={k} value={k}>
            {t(`patientFields.id.kinds.${k}`)}
          </option>
        ))}
      </Select>
      {hasNumber ? (
        <label className={labelClass}>
          <span className="flex items-center justify-between gap-2">
            <span>
              <Req on={required}>{t(`patientFields.id.number.${kind}`)}</Req>
            </span>
            <span
              className={cn(
                'text-[12px] font-semibold tabular-nums',
                complete ? 'text-green' : n > 0 ? 'text-amber' : 'text-ink-3',
              )}
              aria-live="polite"
            >
              {t('patientFields.id.count', {
                n,
                max: national ? NATIONAL_ID_LENGTH : ID_NUMBER_MAX,
              })}
            </span>
          </span>
          <input
            className={cn(
              controlClass,
              'tabular-nums',
              n > 0 && !complete && 'border-amber',
              national && 'tracking-wide',
            )}
            inputMode={national ? 'numeric' : 'text'}
            autoComplete="off"
            spellCheck={false}
            value={value}
            placeholder={national ? '1 1990 8 0012345 0 12' : 'PC1234567'}
            aria-invalid={n > 0 && !complete}
            onChange={(e) => {
              if (national) {
                const digits = nationalIdDigits(e.target.value)
                setCut(digits.length > NATIONAL_ID_LENGTH)
                set('national_id', digits.slice(0, NATIONAL_ID_LENGTH))
              } else set('id_number', cleanIdNumber(e.target.value))
            }}
          />
          <span
            className={cn(
              'text-[12px] font-normal',
              cut ? 'text-amber' : complete ? 'text-green' : 'text-ink-3',
            )}
          >
            {cut ? (
              t('patientFields.id.cut')
            ) : national && complete ? (
              <span className="inline-flex items-center gap-1 tabular-nums">
                <Check size={12} aria-hidden="true" />
                {groupNationalId(value)}
              </span>
            ) : national ? (
              t('patientFields.id.nationalHint', { count: NATIONAL_ID_LENGTH - n })
            ) : (
              t('patientFields.id.otherHint')
            )}
          </span>
        </label>
      ) : (
        <p className="text-ink-3 m-0 self-end pb-2 text-[13px]">
          {kind === 'child' ? t('register.noId.childHint') : t('patientFields.id.noneHint')}
        </p>
      )}
    </div>
  )
}

/** One input for a manager-defined field, by its type. */
export function ExtraInput({
  def,
  value,
  onChange,
}: {
  def: PatientFieldDef
  value: string
  onChange: (v: string) => void
}) {
  const { t } = useTranslation()
  const label = <Req on={def.required}>{def.label}</Req>
  if (def.type === 'choice' || def.type === 'yesno') {
    const options = def.type === 'yesno' ? [t('common.yes'), t('common.no')] : (def.options ?? [])
    return (
      <Select label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
    )
  }
  return (
    <Field
      label={label}
      type={def.type === 'date' ? 'date' : 'text'}
      inputMode={def.type === 'number' ? 'decimal' : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

/**
 * The built-in fields the clinic shows (hidden ones are left out, required ones starred), then
 * the manager's fields in their order. "register": the ID, phone, sector and anything required at
 * once, the other optional details under "More details"; "edit": everything shown.
 */
export function DetailFields({
  draft,
  set,
  setExtra,
  states,
  defs,
  mode,
  extraLocked,
}: {
  draft: PatientDraft
  set: SetDraft
  setExtra: (key: string, value: string) => void
  states: BuiltinStates
  defs: PatientFieldDef[]
  mode: 'register' | 'edit'
  /** A manager field shown locked (the identity level of a private field already filled). */
  extraLocked?: (d: PatientFieldDef) => ReactNode | null
}) {
  const { t } = useTranslation()
  const [more, setMore] = useState(false)
  const f = (k: string) => t(`file.fields.${k}`)
  const req = (k: BuiltinField) => states[k] === 'required'
  const text = (k: keyof PatientDraft, label: ReactNode, extra: Record<string, unknown> = {}) => (
    <Field
      key={k}
      label={label}
      value={String(draft[k] ?? '')}
      onChange={(e) => set(k, e.target.value as never)}
      {...extra}
    />
  )
  const render = (k: BuiltinField): ReactNode => {
    switch (k) {
      case 'national_id':
        return <IdField key={k} draft={draft} set={set} required={req(k)} />
      case 'phone_1':
        return text('phone_1', <Req on={req(k)}>{f('phone_1')}</Req>, {
          type: 'tel',
          placeholder: '07xx xxx xxx',
        })
      case 'phone_2':
        return text('phone_2', <Req on={req(k)}>{f('phone_2')}</Req>, { type: 'tel' })
      case 'email':
        return text('email', <Req on={req(k)}>{t('patientFields.labels.email')}</Req>, {
          type: 'email',
          autoComplete: 'off',
        })
      case 'province':
        return (
          <Select
            key={k}
            label={<Req on={req(k)}>{t('patientFields.labels.province')}</Req>}
            value={draft.province}
            onChange={(e) => set('province', e.target.value)}
          >
            <option value="">—</option>
            {PROVINCES.map((p) => (
              <option key={p} value={p}>
                {t(`patientFields.provinces.${p}`)}
              </option>
            ))}
            {draft.province && !(PROVINCES as readonly string[]).includes(draft.province) && (
              <option value={draft.province}>{draft.province}</option>
            )}
          </Select>
        )
      case 'district':
      case 'sector':
      case 'cell':
      case 'village':
      case 'occupation':
        return text(
          k,
          <Req on={req(k)}>{f(k)}</Req>,
          k === 'sector' ? { placeholder: 'Kiramuruzi' } : {},
        )
      case 'marital_status':
        return (
          <Select
            key={k}
            label={<Req on={req(k)}>{t('patientFields.labels.marital_status')}</Req>}
            value={draft.marital_status}
            onChange={(e) => set('marital_status', e.target.value)}
          >
            <option value="">—</option>
            {MARITAL_STATUSES.map((m) => (
              <option key={m} value={m}>
                {t(`patientFields.marital.${m}`)}
              </option>
            ))}
          </Select>
        )
      case 'ubudehe_category':
        return (
          <Select
            key={k}
            label={<Req on={req(k)}>{f('ubudehe_category')}</Req>}
            value={draft.ubudehe_category}
            onChange={(e) => set('ubudehe_category', e.target.value)}
          >
            <option value="">—</option>
            {['1', '2', '3', '4'].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        )
      case 'emergency':
        return [
          text('emergency_name', <Req on={req(k)}>{f('emergency_name')}</Req>),
          text('emergency_phone', <Req on={req(k)}>{f('emergency_phone')}</Req>, { type: 'tel' }),
        ]
    }
  }
  const shown = BUILTIN_FIELDS.filter((k) => states[k] !== 'hidden')
  // "register": what is asked at once, and the rest under "More details"
  const first = mode === 'edit' ? shown : shown.filter((k) => MAIN_FIELDS.includes(k) || req(k))
  const later = mode === 'edit' ? [] : shown.filter((k) => !first.includes(k))
  const extraFirst = mode === 'edit' ? defs : defs.filter((d) => d.required)
  const extraLater = mode === 'edit' ? [] : defs.filter((d) => !d.required)
  const idFirst = first.includes('national_id')
  const extraInput = (d: PatientFieldDef) =>
    extraLocked?.(d) ?? (
      <ExtraInput
        key={d.key}
        def={d}
        value={draft.extra[d.key] ?? ''}
        onChange={(v) => setExtra(d.key, v)}
      />
    )
  const grid = 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3'
  return (
    <>
      {idFirst && render('national_id')}
      {first.length > (idFirst ? 1 : 0) && (
        <div className={grid}>{first.filter((k) => k !== 'national_id').map(render)}</div>
      )}
      {extraFirst.length > 0 && (
        <>
          {mode === 'edit' && (
            <h3 className="text-ink-2 m-0 mt-2 text-[12px] font-medium">{t('file.more')}</h3>
          )}
          <div className={grid}>{extraFirst.map(extraInput)}</div>
        </>
      )}
      {later.length + extraLater.length > 0 && (
        <div className="border-border flex flex-col gap-3 rounded-md border border-dashed px-3 py-2">
          <button
            type="button"
            className="text-primary inline-flex items-center gap-1.5 self-start text-[13px] font-semibold"
            aria-expanded={more}
            onClick={() => setMore((m) => !m)}
          >
            {more ? (
              <ChevronUp size={16} aria-hidden="true" />
            ) : (
              <ChevronDown size={16} aria-hidden="true" />
            )}
            {t('patientFields.more', { count: later.length + extraLater.length })}
          </button>
          {more && (
            <>
              {later.includes('national_id') && render('national_id')}
              <div className={grid}>
                {later.filter((k) => k !== 'national_id').map(render)}
                {extraLater.map(extraInput)}
              </div>
            </>
          )}
        </div>
      )}
    </>
  )
}

/** Whole years between a YYYY-MM-DD date and today. */
const yearsSince = (iso: string): number => {
  const b = new Date(iso)
  const n = new Date()
  let y = n.getFullYear() - b.getFullYear()
  if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) y -= 1
  return Math.max(0, y)
}
