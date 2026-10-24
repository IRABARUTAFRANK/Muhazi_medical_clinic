import { useState } from 'react'
import { Check, ListPlus, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { usePatientFields, useSavePatientFields, type PatientFieldDef } from '@/lib/api/patients'
import { useConfirm } from '@/lib/confirm'

const TYPES: PatientFieldDef['type'][] = ['text', 'number', 'date', 'choice', 'yesno']

/** Turn a label into a stable storage key: "Next of kin" → "next_of_kin". */
const keyOf = (label: string) =>
  label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)

/**
 * Manager: the extra fields every patient file carries (religion, chronic condition,
 * next of kin…). Saved as the setting `patient.fields`; values are stored per patient.
 */
export function PatientFieldsCard() {
  const { t } = useTranslation()
  const { data } = usePatientFields()
  const save = useSavePatientFields()
  const confirm = useConfirm()
  const [draft, setDraft] = useState<PatientFieldDef[] | null>(null)
  const [seeded, setSeeded] = useState<PatientFieldDef[] | null>(null)
  const [saved, setSaved] = useState(false)
  if (data && seeded !== data && draft === null) {
    setSeeded(data)
    setDraft(structuredClone(data))
  }
  const fields = draft ?? []
  const update = (i: number, patch: Partial<PatientFieldDef>) =>
    setDraft((d) => (d ? d.map((f, j) => (j === i ? { ...f, ...patch } : f)) : d))
  const add = () => setDraft((d) => [...(d ?? []), { key: '', label: '', type: 'text' }])
  const remove = (i: number) => setDraft((d) => (d ? d.filter((_, j) => j !== i) : d))

  const submit = async () => {
    setSaved(false)
    const clean: PatientFieldDef[] = []
    const seen = new Set<string>()
    for (const f of fields) {
      const label = f.label.trim()
      if (!label) continue
      let key = f.key || keyOf(label)
      while (seen.has(key)) key += '_'
      seen.add(key)
      const def: PatientFieldDef = { key, label, type: f.type }
      if (f.type === 'choice') {
        def.options = (f.options ?? []).map((o) => o.trim()).filter(Boolean)
      }
      clean.push(def)
    }
    // a field taken away: its answers are no longer shown on the patient files
    const dropped = (data ?? []).filter((f) => !clean.some((c) => c.key === f.key))
    if (
      !(await confirm({
        title: t('confirm.settings.patientFields.title', { count: clean.length }),
        body:
          dropped.length > 0
            ? t('confirm.settings.patientFields.bodyRemoved', {
                names: dropped.map((f) => f.label).join(', '),
              })
            : t('confirm.settings.patientFields.body'),
        confirmLabel: t('confirm.settings.patientFields.yes'),
        tone: dropped.length > 0 ? 'danger' : 'primary',
      }))
    )
      return
    await save.mutateAsync(clean)
    setDraft(null)
    setSaved(true)
  }

  return (
    <Card>
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          <ListPlus size={16} aria-hidden="true" />
          {t('settings.patientFields.title')}
        </span>
        <Button size="sm" onClick={add}>
          <Plus size={14} aria-hidden="true" />
          {t('settings.patientFields.add')}
        </Button>
      </CardHeader>
      <CardBody className="gap-3">
        <p className="text-ink-2 m-0 text-[13px]">{t('settings.patientFields.lead')}</p>
        {fields.length === 0 && (
          <p className="text-ink-3 m-0 text-[13px]">{t('settings.patientFields.none')}</p>
        )}
        {fields.map((f, i) => (
          <div key={i} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[2fr_1fr_2fr_auto]">
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
              variant="ghost"
              size="sm"
              onClick={() => remove(i)}
              aria-label={t('settings.patientFields.remove')}
              title={t('settings.patientFields.remove')}
            >
              <Trash2 size={16} aria-hidden="true" />
            </Button>
          </div>
        ))}
        {save.error && (
          <p
            role="alert"
            className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
          >
            {save.error.message}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={() => void submit()} loading={save.isPending}>
            <Check size={16} aria-hidden="true" />
            {t('settings.patientFields.save')}
          </Button>
          {saved && !save.isPending && (
            <span className="text-green text-[13px] font-semibold">
              {t('settings.patientFields.saved')}
            </span>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
