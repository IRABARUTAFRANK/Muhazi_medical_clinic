import { useState } from 'react'
import { Check, MailCheck, ShieldOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Select } from '@/components/ui/select'
import {
  TRUST_CHOICES,
  useRevokeAllDevices,
  useSaveTrustSetting,
  useStaffSettings,
} from '@/lib/api/settings'

/**
 * Manager: how often staff receive the e-mailed sign-in code. Mail goes through the clinic's
 * Gmail (about 500 messages a day), so by default a device is trusted for 30 days after one
 * correct code. "Every sign-in" is the strictest choice.
 */
export function OtpCard() {
  const { t } = useTranslation()
  const { data } = useStaffSettings()
  const save = useSaveTrustSetting()
  const revoke = useRevokeAllDevices()
  const [value, setValue] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const current = value ?? data?.trustDays ?? 30

  const label = (d: number) =>
    d === 0 ? t('settings.otp.every') : t('settings.otp.days', { count: d })

  return (
    <Card>
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          <MailCheck size={16} aria-hidden="true" />
          {t('settings.otp.title')}
        </span>
      </CardHeader>
      <CardBody className="gap-3">
        <p className="text-ink-2 m-0 text-[13px]">{t('settings.otp.lead')}</p>
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label={t('settings.otp.ask')}
            value={current}
            onChange={(e) => {
              setValue(Number(e.target.value))
              setNotice(null)
            }}
            wrapperClassName="w-64"
          >
            {TRUST_CHOICES.map((d) => (
              <option key={d} value={d}>
                {label(d)}
              </option>
            ))}
          </Select>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={value == null || value === data?.trustDays}
            onClick={async () => {
              if (value == null) return
              await save.mutateAsync(value)
              setNotice(t('settings.otp.saved'))
            }}
          >
            <Check size={16} aria-hidden="true" />
            {t('settings.lock.save')}
          </Button>
          <Button
            loading={revoke.isPending}
            onClick={async () => {
              const n = await revoke.mutateAsync()
              setNotice(t('settings.otp.revoked', { count: n }))
            }}
          >
            <ShieldOff size={16} aria-hidden="true" />
            {t('settings.otp.revokeAll')}
          </Button>
        </div>
        <p className="text-ink-3 m-0 text-xs">{t('settings.otp.hint')}</p>
        {notice && <p className="text-green m-0 text-[13px] font-semibold">{notice}</p>}
        {(save.error || revoke.error) && (
          <p
            role="alert"
            className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
          >
            {(save.error ?? revoke.error)?.message}
          </p>
        )}
      </CardBody>
    </Card>
  )
}
