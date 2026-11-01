import { useState } from 'react'
import { CircleAlert, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Hint, IconChip } from '@/components/dash/kit'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Flash } from '@/components/ui/flash'
import { StaffLink } from '@/components/staff/staff-link'
import { useSaveInsuranceSetting, useStaffSettings } from '@/lib/api/settings'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'

/**
 * Insurance (manager): the clinic works with insurers, or every patient pays cash. On, the visit
 * screen asks who pays, the Prices page shows the insurers and their tariffs, and the public site
 * names the active partners (setting insurance.enabled, 0115).
 */
export function InsuranceCard() {
  const { t } = useTranslation()
  const { data } = useStaffSettings()
  const save = useSaveInsuranceSetting()
  const confirm = useConfirm()
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const on = data?.insuranceEnabled ?? false

  const toggle = async () => {
    const k = on ? 'confirm.settings.insurance.off' : 'confirm.settings.insurance.on'
    if (
      !(await confirm({
        title: t(`${k}.title`),
        body: t(`${k}.body`),
        confirmLabel: t('confirm.settings.insurance.yes'),
        tone: on ? 'danger' : 'primary',
      }))
    )
      return
    setDone(false)
    setError(null)
    try {
      await save.mutateAsync(!on)
      setDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Card className="anim-enter">
      <CardHeader hue="navy">
        <span className="flex items-center gap-2.5">
          <IconChip icon={ShieldCheck} tint="navy" />
          {t('settings.insurance.title')}
        </span>
      </CardHeader>
      <CardBody className="gap-3">
        <p className="text-ink-2 m-0 text-[14px]">{t('settings.insurance.lead')}</p>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          disabled={save.isPending || !data}
          onClick={() => void toggle()}
          className="flex min-w-0 items-start gap-3 text-left disabled:opacity-60"
        >
          <span
            className={cn(
              'relative inline-flex h-6 w-11 flex-none items-center rounded-full border transition-colors',
              on ? 'border-primary bg-primary' : 'border-border bg-hover',
            )}
          >
            <span
              className={cn(
                'bg-card absolute top-0.5 size-[18px] rounded-full shadow transition-transform',
                on ? 'translate-x-[22px]' : 'translate-x-0.5',
              )}
            />
          </span>
          <span className="min-w-0">
            <span className="text-ink block text-[16px] font-semibold">
              {t(on ? 'settings.insurance.on' : 'settings.insurance.off')}
            </span>
            <span className="text-ink-2 block text-[14px]">
              {t(on ? 'settings.insurance.onHint' : 'settings.insurance.offHint')}
            </span>
          </span>
        </button>
        {error && (
          <p
            role="alert"
            className="border-red/30 bg-red-bg text-red m-0 flex items-start gap-2 rounded-md border px-3 py-2 text-[14px] font-medium"
          >
            <CircleAlert size={16} aria-hidden="true" className="mt-0.5 flex-none" />
            {error}
          </p>
        )}
        {done && <Flash onClose={() => setDone(false)}>{t('settings.insurance.saved')}</Flash>}
        <Hint>
          {t('settings.insurance.pricesNote')}{' '}
          <StaffLink to="/app/prices" className="text-primary font-semibold">
            {t('settings.insurance.pricesLink')}
          </StaffLink>
        </Hint>
      </CardBody>
    </Card>
  )
}
