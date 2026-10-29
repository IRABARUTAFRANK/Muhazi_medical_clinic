import { useState } from 'react'
import { Activity, ArrowDown, ArrowUp, CircleAlert, Save } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Hint, IconChip } from '@/components/dash/kit'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Flash } from '@/components/ui/flash'
import {
  BMI_CODE,
  SETTABLE_VITALS,
  useSaveVitalsSetting,
  useVitalsSetting,
  vitalName,
  vitalType,
} from '@/lib/api/vitals'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'

/**
 * Vital signs (manager, 0102): which measurements of the catalogue the nurse sees by default on
 * every vitals form, and in which order. The rest are added on the patient with "Add a
 * measurement". Stored as the setting `vitals.default`.
 */
export function VitalsCard() {
  const { t } = useTranslation()
  const { data } = useVitalsSetting()
  const save = useSaveVitalsSetting()
  const confirm = useConfirm()
  // the draft: null until the person changes something (the saved set shows meanwhile)
  const [draft, setDraft] = useState<string[] | null>(null)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chosen = draft ?? data?.codes ?? []
  const others = SETTABLE_VITALS.filter((c) => !chosen.includes(c))
  const dirty = draft !== null && draft.join(',') !== (data?.codes ?? []).join(',')

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
  const unitOf = (code: string) => (code === BMI_CODE ? 'kg/m²' : (vitalType(code)?.unit ?? ''))

  const submit = async () => {
    setError(null)
    setDone(false)
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
      setDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
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
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
                      disabled={save.isPending}
                    />
                    <span className="min-w-0 truncate font-semibold">{vitalName({ code }, t)}</span>
                    <span className="text-ink-3 text-[12px]">{unitOf(code)}</span>
                  </label>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t('settings.vitals.up')}
                    title={t('settings.vitals.up')}
                    disabled={i === 0 || save.isPending}
                    onClick={() => move(code, -1)}
                  >
                    <ArrowUp size={16} aria-hidden="true" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t('settings.vitals.down')}
                    title={t('settings.vitals.down')}
                    disabled={i === chosen.length - 1 || save.isPending}
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
                      disabled={save.isPending}
                    />
                    <span className="min-w-0 truncate">{vitalName({ code }, t)}</span>
                    <span className="text-ink-3 text-[12px]">{unitOf(code)}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        </div>
        {error && (
          <p
            role="alert"
            className="border-red/30 bg-red-bg text-red m-0 flex items-start gap-2 rounded-md border px-3 py-2 text-[14px] font-medium"
          >
            <CircleAlert size={16} aria-hidden="true" className="mt-0.5 flex-none" />
            {error}
          </p>
        )}
        {done && <Flash onClose={() => setDone(false)}>{t('settings.vitals.saved')}</Flash>}
        <span className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!dirty}
            onClick={() => void submit()}
          >
            {!save.isPending && <Save size={16} aria-hidden="true" />}
            {t('settings.vitals.save')}
          </Button>
        </span>
        <Hint>{t('settings.vitals.bmiHint')}</Hint>
      </CardBody>
    </Card>
  )
}
