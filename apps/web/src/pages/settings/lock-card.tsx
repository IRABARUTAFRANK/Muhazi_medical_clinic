import { useState } from 'react'
import { Check, Lock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Select } from '@/components/ui/select'
import { LOCK_CHOICES, useSaveLockSetting, useStaffSettings } from '@/lib/api/settings'

/** Manager: how long a staff screen may sit idle before it asks for the PIN again. */
export function LockCard() {
  const { t } = useTranslation()
  const { data } = useStaffSettings()
  const save = useSaveLockSetting()
  const [value, setValue] = useState<number | null>(null)
  const [saved, setSaved] = useState(false)
  const current = value ?? data?.idleMinutes ?? 120

  const label = (m: number) =>
    m < 60 ? t('settings.lock.minutes', { count: m }) : t('settings.lock.hours', { count: m / 60 })

  return (
    <Card>
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          <Lock size={16} aria-hidden="true" />
          {t('settings.lock.title')}
        </span>
      </CardHeader>
      <CardBody className="gap-3">
        <p className="text-ink-2 m-0 text-[13px]">{t('settings.lock.lead')}</p>
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label={t('settings.lock.after')}
            value={current}
            onChange={(e) => {
              setValue(Number(e.target.value))
              setSaved(false)
            }}
            wrapperClassName="w-56"
          >
            {LOCK_CHOICES.map((m) => (
              <option key={m} value={m}>
                {label(m)}
              </option>
            ))}
          </Select>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={value == null || value === data?.idleMinutes}
            onClick={async () => {
              if (value == null) return
              await save.mutateAsync(value)
              setSaved(true)
            }}
          >
            <Check size={16} aria-hidden="true" />
            {t('settings.lock.save')}
          </Button>
          {saved && !save.isPending && (
            <span className="text-green text-[13px] font-semibold">{t('settings.lock.saved')}</span>
          )}
        </div>
        {save.error && (
          <p
            role="alert"
            className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
          >
            {save.error.message}
          </p>
        )}
      </CardBody>
    </Card>
  )
}
