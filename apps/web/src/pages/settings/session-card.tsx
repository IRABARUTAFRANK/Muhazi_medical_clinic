import { useState } from 'react'
import { Check, Clock, ShieldOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Flash } from '@/components/ui/flash'
import { Select } from '@/components/ui/select'
import { useConfirm } from '@/lib/confirm'
import {
  DEFAULT_SESSION_HOURS,
  SESSION_CHOICES,
  useRevokeAllDevices,
  useSaveSessionSetting,
  useStaffSettings,
} from '@/lib/api/settings'

const RULES = ['rule1', 'rule2', 'rule3', 'rule4', 'rule5'] as const

/**
 * Manager: the sign-in session. One rule for everyone: a tab stays signed in while it is used,
 * and signs out after this many hours WITHOUT ACTIVITY (counted from the last click, key, touch
 * or scroll in it); after that, or after any sign-out, a new e-mailed code is needed. Replaces
 * the idle-lock and trusted-days cards.
 */
export function SessionCard() {
  const { t } = useTranslation()
  const { data } = useStaffSettings()
  const save = useSaveSessionSetting()
  const revoke = useRevokeAllDevices()
  const confirm = useConfirm()
  const [value, setValue] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const saved = data?.sessionHours ?? DEFAULT_SESSION_HOURS
  const current = value ?? saved

  return (
    <Card className="xl:col-span-2">
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          <Clock size={16} aria-hidden="true" />
          {t('settings.session.title')}
        </span>
      </CardHeader>
      <CardBody className="gap-3">
        <p className="text-ink-2 m-0 text-[13px]">{t('settings.session.lead', { count: saved })}</p>
        <ul className="text-ink-2 m-0 flex list-disc flex-col gap-1.5 pl-5 text-[13px]">
          {RULES.map((r) => (
            <li key={r}>{t(`settings.session.${r}`, { count: current })}</li>
          ))}
        </ul>
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label={t('settings.session.length')}
            value={current}
            onChange={(e) => {
              setValue(Number(e.target.value))
              setNotice(null)
            }}
            wrapperClassName="w-56"
          >
            {SESSION_CHOICES.map((h) => (
              <option key={h} value={h}>
                {t('settings.session.hours', { count: h })}
              </option>
            ))}
          </Select>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={value == null || value === saved}
            onClick={async () => {
              if (value == null) return
              if (
                !(await confirm({
                  title: t('confirm.settings.session.title', { count: value }),
                  body: t('confirm.settings.session.body'),
                  confirmLabel: t('confirm.settings.saveYes'),
                }))
              )
                return
              await save.mutateAsync(value)
              setValue(null)
              setNotice(t('settings.session.saved'))
            }}
          >
            <Check size={16} aria-hidden="true" />
            {t('settings.lock.save')}
          </Button>
          <Button
            loading={revoke.isPending}
            onClick={async () => {
              if (
                !(await confirm({
                  title: t('confirm.settings.session.revokeTitle'),
                  body: t('confirm.settings.session.revokeBody'),
                  confirmLabel: t('confirm.settings.session.revokeYes'),
                  tone: 'danger',
                }))
              )
                return
              const n = await revoke.mutateAsync()
              setNotice(t('settings.otp.revoked', { count: n }))
            }}
          >
            <ShieldOff size={16} aria-hidden="true" />
            {t('settings.otp.revokeAll')}
          </Button>
        </div>
        <p className="text-ink-3 m-0 text-xs">{t('settings.session.revokeHint')}</p>
        {notice && (
          <Flash key={notice} onClose={() => setNotice(null)}>
            {notice}
          </Flash>
        )}
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
