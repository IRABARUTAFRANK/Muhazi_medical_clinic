import { useState } from 'react'
import { Route } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { IconChip } from '@/components/dash/kit'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Flash } from '@/components/ui/flash'
import { useSaveFlowSetting, useStaffSettings } from '@/lib/api/settings'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'

/**
 * Patient flow (manager): new visits go straight to the chosen desk (default), or every
 * patient passes at triage first. Vitals can be recorded at any desk either way.
 */
export function FlowCard() {
  const { t } = useTranslation()
  const { data } = useStaffSettings()
  const save = useSaveFlowSetting()
  const confirm = useConfirm()
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const current = data?.triageFirst ?? false

  const choose = async (v: boolean) => {
    // the flow in use already: nothing changes, nothing to ask
    if (v === current) return
    const k = v ? 'confirm.settings.flow.triageFirst' : 'confirm.settings.flow.deskFirst'
    if (
      !(await confirm({
        title: t(`${k}.title`),
        body: t(`${k}.body`),
        confirmLabel: t('confirm.settings.flow.yes'),
      }))
    )
      return
    setDone(false)
    setError(null)
    try {
      await save.mutateAsync(v)
      setDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Card className="anim-enter">
      <CardHeader>
        <span className="flex items-center gap-2.5">
          <IconChip icon={Route} tint="amber" />
          {t('settings.flow.title')}
        </span>
      </CardHeader>
      <CardBody className="gap-3">
        <p className="text-ink-2 m-0 text-[14px]">{t('settings.flow.lead')}</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {([false, true] as const).map((v) => {
            const on = current === v
            return (
              <button
                key={String(v)}
                type="button"
                aria-pressed={on}
                disabled={save.isPending}
                onClick={() => void choose(v)}
                className={cn(
                  'flex flex-col gap-1 rounded-md border p-3 text-left transition-colors duration-120',
                  on ? 'border-amber/40 bg-amber-bg' : 'border-border bg-card hover:bg-hover',
                )}
              >
                <span className={cn('text-[16px] font-semibold', on && 'text-amber')}>
                  {t(v ? 'settings.flow.triageFirst' : 'settings.flow.deskFirst')}
                </span>
                <span className="text-ink-2 text-[14px]">
                  {t(v ? 'settings.flow.triageFirstHint' : 'settings.flow.deskFirstHint')}
                </span>
              </button>
            )
          })}
        </div>
        {error && (
          <p
            role="alert"
            className="border-red/30 bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[14px] font-medium"
          >
            {error}
          </p>
        )}
        {done && <Flash onClose={() => setDone(false)}>{t('settings.flow.saved')}</Flash>}
        <Button type="button" size="sm" variant="ghost" className="self-start" disabled>
          {t('settings.flow.vitalsNote')}
        </Button>
      </CardBody>
    </Card>
  )
}
