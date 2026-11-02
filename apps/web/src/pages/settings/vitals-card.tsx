import { useState } from 'react'
import {
  Activity,
  ArrowDown,
  ArrowUp,
  CircleAlert,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Hint, IconChip } from '@/components/dash/kit'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Flash } from '@/components/ui/flash'
import { Select } from '@/components/ui/select'
import {
  BMI_CODE,
  useRestoreVitalType,
  useRetireVitalType,
  useSaveVitalType,
  useSaveVitalsSetting,
  useVitalTypes,
  useVitalsSetting,
  vitalName,
  type VitalKind,
  type VitalType,
} from '@/lib/api/vitals'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'

/** The inline form: a new measurement, or a custom one being changed. */
interface Draft {
  /** null: a new one. */
  code: string | null
  name: string
  unit: string
  kind: VitalKind
  min: string
  max: string
}
const emptyDraft = (): Draft => ({
  code: null,
  name: '',
  unit: '',
  kind: 'number',
  min: '',
  max: '',
})
const draftOf = (v: VitalType): Draft => ({
  code: v.code,
  name: v.name ?? '',
  unit: v.unit,
  kind: v.kind,
  min: v.min != null ? String(v.min) : '',
  max: v.max != null ? String(v.max) : '',
})
const numOrNull = (s: string): number | null => {
  const t = s.trim().replace(',', '.')
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : NaN
}

/**
 * Vital signs (manager, 0102, 0119): which measurements the nurse sees by default on every
 * vitals form, and in which order (stored as the setting `vitals.default`); and the
 * measurements themselves. The manager adds one of the clinic's own (a number with an optional
 * range, or a text), renames a custom one (its unit, kind and range too), retires a custom one
 * that is not in the default set (hidden from every form; what was recorded with it stays) and
 * shows it again from the "Retired" strip. The built-in ones are only ticked or left out.
 */
export function VitalsCard() {
  const { t } = useTranslation()
  const { data } = useVitalsSetting()
  const { data: types = [] } = useVitalTypes()
  const save = useSaveVitalsSetting()
  const saveType = useSaveVitalType()
  const retire = useRetireVitalType()
  const restore = useRestoreVitalType()
  const confirm = useConfirm()
  // the draft: null until the person changes something (the saved set shows meanwhile)
  const [draft, setDraft] = useState<string[] | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // the inline form for a measurement (null: closed)
  const [editing, setEditing] = useState<Draft | null>(null)
  const active = types.filter((v) => !v.retired)
  const retired = types.filter((v) => v.retired)
  const settable = [...active.map((v) => v.code), BMI_CODE]
  const chosen = (draft ?? data?.codes ?? []).filter((c) => settable.includes(c))
  const others = settable.filter((c) => !chosen.includes(c))
  const dirty = draft !== null && draft.join(',') !== (data?.codes ?? []).join(',')
  const typeOf = (code: string) => types.find((v) => v.code === code)
  const nameOf = (code: string) => vitalName({ code, name: typeOf(code)?.name }, t)
  const unitOf = (code: string) => (code === BMI_CODE ? 'kg/m²' : (typeOf(code)?.unit ?? ''))
  const busy = save.isPending || saveType.isPending || retire.isPending || restore.isPending

  const toggle = (code: string) =>
    setDraft(chosen.includes(code) ? chosen.filter((c) => c !== code) : [...chosen, code])
  const move = (code: string, by: -1 | 1) => {
    const i = chosen.indexOf(code)
    const j = i + by
    if (i < 0 || j < 0 || j >= chosen.length) return
    const next = [...chosen]
    next[i] = chosen[j]!
    next[j] = code
    setDraft(next)
  }

  const submit = async () => {
    setError(null)
    setDone(null)
    if (chosen.length === 0) return setError(t('settings.vitals.none'))
    if (
      !(await confirm({
        title: t('confirm.settings.vitals.title'),
        body: t('confirm.settings.vitals.body'),
        confirmLabel: t('confirm.settings.vitals.yes'),
      }))
    )
      return
    try {
      await save.mutateAsync(chosen)
      setDraft(null)
      setDone(t('settings.vitals.saved'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** The inline form saved: a new measurement, or the changed custom one. */
  const submitType = async () => {
    if (!editing) return
    setError(null)
    setDone(null)
    const name = editing.name.trim()
    if (!name) return setError(t('settings.vitals.manage.nameNeeded'))
    const min = editing.kind === 'text' ? null : numOrNull(editing.min)
    const max = editing.kind === 'text' ? null : numOrNull(editing.max)
    if (Number.isNaN(min) || Number.isNaN(max))
      return setError(t('settings.vitals.manage.rangeNumbers'))
    if (min != null && max != null && min >= max)
      return setError(t('settings.vitals.manage.rangeOrder'))
    try {
      const saved = await saveType.mutateAsync({
        code: editing.code,
        name,
        unit: editing.unit,
        kind: editing.kind,
        min,
        max,
      })
      setEditing(null)
      setDone(
        t(editing.code ? 'settings.vitals.manage.changed' : 'settings.vitals.manage.added', {
          name: saved.name ?? name,
        }),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** A custom measurement retired (not in the default set): with a question first. */
  const retireType = async (v: VitalType) => {
    setError(null)
    setDone(null)
    const name = vitalName(v, t)
    if (
      !(await confirm({
        title: t('confirm.settings.vitals.retireTitle', { name }),
        body: t('confirm.settings.vitals.retireBody'),
        confirmLabel: t('confirm.settings.vitals.retireYes'),
        tone: 'danger',
      }))
    )
      return
    try {
      await retire.mutateAsync(v.code)
      setDone(t('settings.vitals.manage.retired', { name }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const restoreType = async (v: VitalType) => {
    setError(null)
    setDone(null)
    try {
      await restore.mutateAsync(v.code)
      setDone(t('settings.vitals.manage.restored', { name: vitalName(v, t) }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** The pencil and the bin of a custom row (the bin only outside the default set). */
  const customTools = (code: string, inDefault: boolean) => {
    const v = typeOf(code)
    if (!v?.custom) return null
    return (
      <>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t('settings.vitals.manage.edit', { name: nameOf(code) })}
          title={t('settings.vitals.manage.edit', { name: nameOf(code) })}
          disabled={busy}
          onClick={() => {
            setError(null)
            setEditing(draftOf(v))
          }}
        >
          <Pencil size={16} aria-hidden="true" />
        </Button>
        {!inDefault && (
          <Button
            size="icon"
            variant="ghost"
            className="text-red hover:bg-red-bg"
            aria-label={t('settings.vitals.manage.retire', { name: nameOf(code) })}
            title={t('settings.vitals.manage.retire', { name: nameOf(code) })}
            disabled={busy}
            onClick={() => void retireType(v)}
          >
            <Trash2 size={16} aria-hidden="true" />
          </Button>
        )}
      </>
    )
  }

  const rowClass =
    'border-border bg-card flex min-h-10 items-center gap-2 rounded-md border px-2.5 py-1 text-[14px]'
  return (
    <Card className="anim-enter">
      <CardHeader hue="mint">
        <span className="flex items-center gap-2.5">
          <IconChip icon={Activity} tint="mint" />
          {t('settings.vitals.title')}
        </span>
      </CardHeader>
      <CardBody className="gap-3">
        <p className="text-ink-2 m-0 text-[14px]">{t('settings.vitals.lead')}</p>
        {/* two columns only when the card itself is wide enough for the names to stay whole
            (a large text size on a desktop monitor narrows it) */}
        <div className="@container">
          <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <span className="text-ink-2 text-[13px] font-semibold">
                {t('settings.vitals.shown', { count: chosen.length })}
              </span>
              <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
                {chosen.map((code, i) => (
                  <li key={code} className={cn(rowClass, 'border-green/40 bg-green-bg/40')}>
                    <span className="text-ink-3 w-5 text-right text-[12px] tabular-nums">
                      {i + 1}.
                    </span>
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        className="accent-primary"
                        checked
                        onChange={() => toggle(code)}
                        disabled={busy}
                      />
                      <span className="min-w-0 flex-1 font-semibold">{nameOf(code)}</span>
                      <span className="text-ink-3 shrink-0 text-[12px] whitespace-nowrap">
                        {unitOf(code)}
                      </span>
                    </label>
                    {customTools(code, true)}
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t('settings.vitals.up')}
                      title={t('settings.vitals.up')}
                      disabled={i === 0 || busy}
                      onClick={() => move(code, -1)}
                    >
                      <ArrowUp size={16} aria-hidden="true" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t('settings.vitals.down')}
                      title={t('settings.vitals.down')}
                      disabled={i === chosen.length - 1 || busy}
                      onClick={() => move(code, 1)}
                    >
                      <ArrowDown size={16} aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ol>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-ink-2 text-[13px] font-semibold">
                {t('settings.vitals.others')}
              </span>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {others.map((code) => (
                  <li key={code} className={rowClass}>
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        className="accent-primary"
                        checked={false}
                        onChange={() => toggle(code)}
                        disabled={busy}
                      />
                      <span className="min-w-0 flex-1">{nameOf(code)}</span>
                      <span className="text-ink-3 shrink-0 text-[12px] whitespace-nowrap">
                        {typeOf(code)?.kind === 'text'
                          ? t('settings.vitals.manage.text')
                          : unitOf(code)}
                      </span>
                    </label>
                    {customTools(code, false)}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        {/* Add a measurement of the clinic's own, or change a custom one */}
        {editing ? (
          <div className="border-primary/40 bg-primary-tint/40 grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-2">
            <span className="text-ink-2 col-span-full text-[13px] font-semibold">
              {editing.code
                ? t('settings.vitals.manage.editTitle', { name: nameOf(editing.code) })
                : t('settings.vitals.manage.addTitle')}
            </span>
            <Field
              label={t('settings.vitals.manage.name')}
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder={t('vitalsForm.customNamePh')}
              maxLength={60}
              autoFocus
            />
            <Field
              label={t('settings.vitals.manage.unit')}
              value={editing.unit}
              onChange={(e) => setEditing({ ...editing, unit: e.target.value })}
              placeholder={t('vitalsForm.customUnitPh')}
              maxLength={20}
            />
            <Select
              label={t('settings.vitals.manage.kind')}
              value={editing.kind}
              onChange={(e) => setEditing({ ...editing, kind: e.target.value as VitalKind })}
            >
              <option value="number">{t('settings.vitals.manage.number')}</option>
              <option value="text">{t('settings.vitals.manage.text')}</option>
            </Select>
            {editing.kind === 'number' && (
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label={t('settings.vitals.manage.min')}
                  inputMode="decimal"
                  value={editing.min}
                  onChange={(e) => setEditing({ ...editing, min: e.target.value })}
                />
                <Field
                  label={t('settings.vitals.manage.max')}
                  inputMode="decimal"
                  value={editing.max}
                  onChange={(e) => setEditing({ ...editing, max: e.target.value })}
                />
              </div>
            )}
            <p className="text-ink-3 col-span-full m-0 text-[12px]">
              {editing.kind === 'number'
                ? t('settings.vitals.manage.rangeHint')
                : t('settings.vitals.manage.textHint')}
            </p>
            <span className="col-span-full flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="sm"
                loading={saveType.isPending}
                onClick={() => void submitType()}
              >
                {!saveType.isPending && <Save size={14} aria-hidden="true" />}
                {t(
                  editing.code ? 'settings.vitals.manage.saveChange' : 'settings.vitals.manage.add',
                )}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                {t('staff.form.cancel')}
              </Button>
            </span>
          </div>
        ) : (
          <span>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                setError(null)
                setDone(null)
                setEditing(emptyDraft())
              }}
            >
              <Plus size={14} aria-hidden="true" />
              {t('vitalsForm.addMeasurement')}
            </Button>
          </span>
        )}

        {/* retired measurements: hidden from the forms, shown again from here */}
        {retired.length > 0 && (
          <div className="border-border bg-hover/50 flex flex-col gap-1.5 rounded-md border p-2.5">
            <span className="text-ink-2 text-[13px] font-semibold">
              {t('settings.vitals.manage.retiredTitle', { count: retired.length })}
            </span>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {retired.map((v) => (
                <li
                  key={v.code}
                  className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[14px]"
                >
                  <span className="text-ink-2 min-w-0 flex-1">
                    {vitalName(v, t)}
                    {v.unit ? <span className="text-ink-3 text-[12px]"> · {v.unit}</span> : null}
                  </span>
                  <Button
                    size="xs"
                    disabled={busy}
                    onClick={() => void restoreType(v)}
                    aria-label={t('settings.vitals.manage.showAgainOf', { name: vitalName(v, t) })}
                  >
                    <RotateCcw size={12} aria-hidden="true" />
                    {t('settings.vitals.manage.showAgain')}
                  </Button>
                </li>
              ))}
            </ul>
            <span className="text-ink-3 text-[12px]">
              {t('settings.vitals.manage.retiredHint')}
            </span>
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="border-red/30 bg-red-bg text-red m-0 flex items-start gap-2 rounded-md border px-3 py-2 text-[14px] font-medium"
          >
            <CircleAlert size={16} aria-hidden="true" className="mt-0.5 flex-none" />
            {error}
          </p>
        )}
        {done && <Flash onClose={() => setDone(null)}>{done}</Flash>}
        <span className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!dirty || busy}
            onClick={() => void submit()}
          >
            {!save.isPending && <Save size={16} aria-hidden="true" />}
            {t('settings.vitals.save')}
          </Button>
        </span>
        <Hint>{t('settings.vitals.bmiHint')}</Hint>
        <Hint>{t('settings.vitals.manage.builtinHint')}</Hint>
      </CardBody>
    </Card>
  )
}
