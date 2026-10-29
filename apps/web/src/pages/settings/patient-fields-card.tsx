import { useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  CircleAlert,
  Inbox,
  ListPlus,
  Lock,
  Plus,
  Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { IconChip } from '@/components/dash/kit'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Seg } from '@/components/ui/seg'
import { Select } from '@/components/ui/select'
import {
  usePatientBuiltins,
  usePatientFields,
  useSavePatientBuiltins,
  useSavePatientFields,
  type PatientFieldDef,
} from '@/lib/api/patients'
import { useConfirm } from '@/lib/confirm'
import { BUILTIN_FIELDS, type BuiltinStates, type FieldState } from '@/lib/patient-rules'
import { cn } from '@/lib/utils'

const TYPES: PatientFieldDef['type'][] = ['text', 'number', 'date', 'choice', 'yesno']
const STATES: FieldState[] = ['shown', 'hidden', 'required']

/** Turn a label into a stable storage key: "Next of kin" → "next_of_kin". */
const keyOf = (label: string) =>
  label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)

const sameStates = (a: BuiltinStates, b: BuiltinStates) =>
  BUILTIN_FIELDS.every((k) => a[k] === b[k])

/**
 * Manager: what the patient file asks. The built-in fields (ID, phones, address, next of kin…)
 * are shown, hidden or required (setting `patient.builtins`, 0108); the identity (surname, given
 * names, sex, date of birth or age) is always asked. Below, the clinic's own fields (religion,
 * chronic condition…), each optionally required, in the order the forms show them (setting
 * `patient.fields`; values are stored per patient). Registration, a booked patient's arrival and
 * Edit details follow both.
 */
export function PatientFieldsCard() {
  const { t } = useTranslation()
  const { data } = usePatientFields()
  const { data: builtins } = usePatientBuiltins()
  const save = useSavePatientFields()
  const saveBuiltins = useSavePatientBuiltins()
  const confirm = useConfirm()
  const [draft, setDraft] = useState<PatientFieldDef[] | null>(null)
  const [seeded, setSeeded] = useState<PatientFieldDef[] | null>(null)
  const [states, setStates] = useState<BuiltinStates | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (data && seeded !== data && draft === null) {
    setSeeded(data)
    setDraft(structuredClone(data))
  }
  const fields = draft ?? []
  const shownStates = states ?? builtins
  const update = (i: number, patch: Partial<PatientFieldDef>) =>
    setDraft((d) => (d ? d.map((f, j) => (j === i ? { ...f, ...patch } : f)) : d))
  const add = () => setDraft((d) => [...(d ?? []), { key: '', label: '', type: 'text' }])
  const remove = (i: number) => setDraft((d) => (d ? d.filter((_, j) => j !== i) : d))
  const move = (i: number, by: -1 | 1) =>
    setDraft((d) => {
      if (!d) return d
      const j = i + by
      if (j < 0 || j >= d.length) return d
      const next = [...d]
      next[i] = d[j]!
      next[j] = d[i]!
      return next
    })

  const submit = async () => {
    setSaved(false)
    setError(null)
    const clean: PatientFieldDef[] = []
    const seen = new Set<string>()
    for (const f of fields) {
      const label = f.label.trim()
      if (!label) continue
      let key = f.key || keyOf(label)
      while (seen.has(key)) key += '_'
      seen.add(key)
      const def: PatientFieldDef = { key, label, type: f.type }
      if (f.private) def.private = true
      if (f.required) def.required = true
      if (f.type === 'choice') {
        def.options = (f.options ?? []).map((o) => o.trim()).filter(Boolean)
      }
      clean.push(def)
    }
    // a field taken away: its answers are no longer shown on the patient files
    const dropped = (data ?? []).filter((f) => !clean.some((c) => c.key === f.key))
    const required = [
      ...BUILTIN_FIELDS.filter((k) => shownStates?.[k] === 'required').map((k) =>
        t(`patientFields.builtin.${k}`),
      ),
      ...clean.filter((c) => c.required).map((c) => c.label),
    ]
    if (
      !(await confirm({
        title: t('confirm.settings.patientFields.title', { count: clean.length }),
        body: [
          dropped.length > 0
            ? t('confirm.settings.patientFields.bodyRemoved', {
                names: dropped.map((f) => f.label).join(', '),
              })
            : t('confirm.settings.patientFields.body'),
          required.length > 0
            ? t('patientFields.settings.confirmRequired', { names: required.join(', ') })
            : '',
        ]
          .filter(Boolean)
          .join(' '),
        confirmLabel: t('confirm.settings.patientFields.yes'),
        tone: dropped.length > 0 ? 'danger' : 'primary',
      }))
    )
      return
    try {
      if (states && builtins && !sameStates(states, builtins))
        await saveBuiltins.mutateAsync(states)
      await save.mutateAsync(clean)
      setDraft(null)
      setStates(null)
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const busy = save.isPending || saveBuiltins.isPending
  return (
    <Card>
      <CardHeader>
        <span className="inline-flex items-center gap-2.5">
          <IconChip icon={ListPlus} tint="violet" />
          {t('settings.patientFields.title')}
        </span>
      </CardHeader>
      <CardBody className="gap-4">
        <p className="text-ink-2 m-0 text-[14px]">{t('patientFields.settings.lead')}</p>

        {/* the built-in fields: shown, hidden or required */}
        <section className="flex flex-col gap-2" aria-labelledby="pf-builtin">
          <h3 id="pf-builtin" className="text-ink m-0 text-[15px] font-semibold">
            {t('patientFields.settings.builtinTitle')}
          </h3>
          <p className="text-ink-3 m-0 text-[13px]">{t('patientFields.settings.builtinHint')}</p>
          <div className="border-border bg-hover/50 text-ink-2 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-[14px]">
            <Lock size={14} aria-hidden="true" className="text-ink-3 flex-none" />
            <span className="min-w-0 flex-1 font-medium">{t('patientFields.settings.core')}</span>
            <span className="text-ink-3 text-[13px]">{t('patientFields.settings.coreState')}</span>
          </div>
          {shownStates && (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {BUILTIN_FIELDS.map((k) => (
                <li
                  key={k}
                  className={cn(
                    'border-border flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border px-3 py-1.5',
                    shownStates[k] === 'hidden' && 'bg-hover/40',
                    shownStates[k] === 'required' && 'border-primary/40',
                  )}
                >
                  <span
                    className={cn(
                      'min-w-40 flex-1 text-[14px] font-medium',
                      shownStates[k] === 'hidden' && 'text-ink-3',
                    )}
                  >
                    {t(`patientFields.builtin.${k}`)}
                  </span>
                  <Seg
                    size="sm"
                    label={t(`patientFields.builtin.${k}`)}
                    value={shownStates[k]}
                    onChange={(v) => {
                      setSaved(false)
                      setStates({ ...shownStates, [k]: v })
                    }}
                    options={STATES.map((s) => ({
                      value: s,
                      label: t(`patientFields.settings.states.${s}`),
                    }))}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* the clinic's own fields */}
        <section className="flex flex-col gap-3" aria-labelledby="pf-extra">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="pf-extra" className="text-ink m-0 text-[15px] font-semibold">
              {t('patientFields.settings.extraTitle')}
            </h3>
            <Button size="sm" variant="tint-teal" onClick={add}>
              <Plus size={16} aria-hidden="true" />
              {t('settings.patientFields.add')}
            </Button>
          </div>
          <p className="text-ink-3 m-0 text-[13px]">{t('settings.patientFields.lead')}</p>
          {fields.length === 0 && (
            <p className="text-ink-3 m-0 flex items-center gap-2 text-[14px]">
              <Inbox size={16} aria-hidden="true" className="flex-none" />
              {t('settings.patientFields.none')}
            </p>
          )}
          {fields.map((f, i) => (
            <div
              key={i}
              className="border-grid grid grid-cols-1 items-end gap-3 border-b pb-3 last-of-type:border-b-0 last-of-type:pb-0 sm:grid-cols-[auto_minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)_auto]"
            >
              {/* the order the forms show the fields in */}
              <span className="flex gap-1 sm:flex-col">
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={t('patientFields.settings.up', { name: f.label || '…' })}
                  title={t('patientFields.settings.up', { name: f.label || '…' })}
                >
                  <ArrowUp size={16} aria-hidden="true" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={i === fields.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label={t('patientFields.settings.down', { name: f.label || '…' })}
                  title={t('patientFields.settings.down', { name: f.label || '…' })}
                >
                  <ArrowDown size={16} aria-hidden="true" />
                </Button>
              </span>
              <Field
                label={t('settings.patientFields.label')}
                value={f.label}
                onChange={(e) => update(i, { label: e.target.value, key: f.key || '' })}
                placeholder={t('settings.patientFields.labelPh')}
              />
              <Select
                label={t('settings.patientFields.type')}
                value={f.type}
                onChange={(e) => update(i, { type: e.target.value as PatientFieldDef['type'] })}
              >
                {TYPES.map((k) => (
                  <option key={k} value={k}>
                    {t(`settings.patientFields.types.${k}`)}
                  </option>
                ))}
              </Select>
              {f.type === 'choice' ? (
                <Field
                  label={t('settings.patientFields.options')}
                  value={(f.options ?? []).join(', ')}
                  onChange={(e) => update(i, { options: e.target.value.split(',') })}
                  placeholder={t('settings.patientFields.optionsPh')}
                />
              ) : (
                <span className="text-ink-3 hidden text-xs sm:block">
                  {t(`settings.patientFields.hints.${f.type}`)}
                </span>
              )}
              <Button
                variant="tint-coral"
                size="md"
                className="sm:mb-0"
                onClick={() => remove(i)}
                aria-label={t('settings.patientFields.remove')}
                title={t('settings.patientFields.remove')}
              >
                <Trash2 size={16} aria-hidden="true" />
              </Button>
              <span className="flex flex-col gap-1.5 sm:col-span-5">
                <label className="text-ink-2 flex items-start gap-2 text-[14px]">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={!!f.required}
                    onChange={(e) => update(i, { required: e.target.checked })}
                  />
                  <span>
                    <b>{t('patientFields.settings.required')}</b>
                    {' · '}
                    {t('patientFields.settings.requiredHint')}
                  </span>
                </label>
                <label className="text-ink-2 flex items-start gap-2 text-[14px]">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={!!f.private}
                    onChange={(e) => update(i, { private: e.target.checked })}
                  />
                  <span>
                    <b>{t('settings.patientFields.private')}</b>
                    {' · '}
                    {t('settings.patientFields.privateHint')}
                  </span>
                </label>
              </span>
            </div>
          ))}
        </section>
        {(error || save.error || saveBuiltins.error) && (
          <p
            role="alert"
            className="border-red/30 bg-red-bg text-red m-0 flex items-start gap-2 rounded-md border px-3 py-2 text-[14px] font-medium"
          >
            <CircleAlert size={16} aria-hidden="true" className="mt-0.5 flex-none" />
            {error ?? save.error?.message ?? saveBuiltins.error?.message}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            <Check size={16} aria-hidden="true" />
            {t('settings.patientFields.save')}
          </Button>
          {saved && !busy && (
            <span className="text-green inline-flex items-center gap-1 text-[14px] font-semibold">
              <Check size={16} aria-hidden="true" />
              {t('patientFields.settings.saved')}
            </span>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
