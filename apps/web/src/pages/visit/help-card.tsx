import { useState } from 'react'
import { HandHelping, Send, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Flash } from '@/components/ui/flash'
import { useCallActions, type VisitAccess } from '@/lib/api/calls'
import { useColleagues } from '@/lib/api/referrals'
import { useConfirm } from '@/lib/confirm'

const control =
  'border-border bg-card text-ink focus:border-primary h-10 w-full rounded-md border px-2.5 text-[14px] outline-none'

/**
 * "Ask a colleague for help" on the visit screen: one colleague or every doctor, with what the
 * question is. The colleague who accepts may work on the patient until either of them ends it.
 */
export function HelpCard({
  encounterId,
  user,
  access,
  patientName,
}: {
  encounterId: string
  /** For the questions asked before each action. */
  patientName?: string
  user: StaffUser
  access: VisitAccess
}) {
  const { t } = useTranslation()
  const actions = useCallActions()
  const { data: colleagues = [] } = useColleagues()
  const [open, setOpen] = useState(false)
  const [toUser, setToUser] = useState('')
  const [note, setNote] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const clinicians = colleagues.filter(
    (c) => c.id !== user.id && (c.role === 'doctor' || c.role === 'nurse'),
  )
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setError(null)
    setNotice(null)
    try {
      await fn()
      setNotice(done)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const pending = actions.askHelp.isPending || actions.cancel.isPending
  const confirm = useConfirm()
  const name = patientName || t('confirm.visit.thisPatient')
  const askHelp = async () => {
    const who = clinicians.find((c) => c.id === toUser)?.name ?? t('calls.help.anyDoctor')
    if (
      !(await confirm({
        title: toUser
          ? t('confirm.visit.helpAsk', { who, name })
          : t('confirm.visit.helpAskAny', { name }),
        body: t('confirm.visit.helpAskBody'),
        confirmLabel: t('confirm.visit.helpAskYes'),
      }))
    )
      return
    await run(
      async () => {
        await actions.askHelp.mutateAsync({ encounterId, toUser: toUser || null, note })
        setOpen(false)
        setNote('')
      },
      t('calls.help.sent', { who }),
    )
  }
  const endHelp = async (h: VisitAccess['help'][number]) => {
    const withdraw = h.status !== 'accepted'
    const key = withdraw
      ? 'confirm.visit.helpWithdraw'
      : h.helperIsMe
        ? 'confirm.visit.helpEndMine'
        : 'confirm.visit.helpEnd'
    const helper = h.helper ?? t('calls.help.anyDoctor')
    if (
      !(await confirm({
        title: t(key, { name, helper }),
        body: t(`${key}Body`, { name, helper }),
        confirmLabel: t(withdraw ? 'confirm.visit.helpWithdrawYes' : 'confirm.visit.helpEndYes'),
        tone: 'danger',
      }))
    )
      return
    await run(
      () => actions.cancel.mutateAsync(h.callId),
      t(h.status === 'accepted' ? 'calls.help.ended' : 'calls.help.withdrawn'),
    )
  }

  return (
    <Card className="anim-enter">
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          <HandHelping size={16} aria-hidden="true" />
          {t('calls.help.title')}
        </span>
      </CardHeader>
      <CardBody className="gap-3">
        {error && (
          <Flash tone="error" onClose={() => setError(null)}>
            {error}
          </Flash>
        )}
        {notice && (
          <Flash key={notice} onClose={() => setNotice(null)}>
            {notice}
          </Flash>
        )}
        {access.help.map((h) => (
          <div
            key={h.callId}
            className="border-border flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border px-3 py-2"
          >
            <span className="min-w-[200px] flex-1 text-[14px]">
              <span className="block font-semibold">
                {h.status === 'accepted'
                  ? t('calls.help.helping', { helper: h.helper ?? '', asker: h.asker })
                  : t('calls.help.waiting', { helper: h.helper ?? t('calls.help.anyDoctor') })}
              </span>
              {h.note && <span className="text-ink-2 block text-[13px]">“{h.note}”</span>}
            </span>
            <Badge tone={h.status === 'accepted' ? 'green' : 'yellow'}>
              {t(`calls.help.status.${h.status}`)}
            </Badge>
            {(h.mine || h.helperIsMe) && (
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => void endHelp(h)}>
                <X size={14} aria-hidden="true" />
                {t(
                  h.status === 'accepted'
                    ? h.helperIsMe
                      ? 'calls.help.endMine'
                      : 'calls.help.end'
                    : 'calls.help.withdraw',
                )}
              </Button>
            )}
          </div>
        ))}

        {!access.helping &&
          (!open ? (
            <span className="flex flex-wrap items-center gap-3">
              <Button onClick={() => setOpen(true)}>
                <HandHelping size={16} aria-hidden="true" />
                {t('calls.help.ask')}
              </Button>
              <span className="text-ink-3 text-[13px]">{t('calls.help.lead')}</span>
            </span>
          ) : (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
                {t('calls.help.who')}
                <select
                  className={control}
                  value={toUser}
                  onChange={(e) => setToUser(e.target.value)}
                >
                  <option value="">{t('calls.help.anyDoctor')}</option>
                  {clinicians.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {t(`staff.roles.${c.role}`, { defaultValue: c.role })}
                      {c.department ? ` · ${c.department}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
                {t('calls.help.what')}
                <textarea
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t('calls.help.whatPh')}
                  className="border-border bg-card focus:border-primary rounded-md border px-2.5 py-2 text-[14px] font-normal outline-none"
                />
              </label>
              <span className="flex flex-wrap gap-2">
                <Button variant="primary" disabled={pending} onClick={() => void askHelp()}>
                  <Send size={16} aria-hidden="true" />
                  {t('calls.help.send')}
                </Button>
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  {t('staff.form.cancel')}
                </Button>
              </span>
            </div>
          ))}
      </CardBody>
    </Card>
  )
}
