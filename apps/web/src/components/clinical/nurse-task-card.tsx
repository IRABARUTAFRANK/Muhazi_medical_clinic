import { useState, type FormEvent } from 'react'
import { ClipboardList } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatTime } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { NurseRecipient } from '@/components/clinical/nurse-recipient'
import { useDeskOps, useVisitTasks } from '@/lib/api/desk-ops'
import { useOrderNurses } from '@/lib/api/nurse-orders'
import { useConfirm } from '@/lib/confirm'
import { useSession } from '@/store/session'

const pad = (n: number) => String(n).padStart(2, '0')
const inAnHour = () => {
  const d = new Date(Date.now() + 60 * 60_000)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Doctor → nurse: leave a task on this visit ("injection at 14:00", "repeat vitals in 1 h").
 * It appears at once on the nurses' dashboard. The giver may withdraw it; the nurse ticks it
 * off here or on her dashboard, or says why it could not be done.
 */
export function NurseTaskCard({
  encounterId,
  patientName,
  nurse = false,
}: {
  encounterId: string
  /** For the questions asked before each action. */
  patientName?: string
  /** The nurse's view: no new task, Done / Not done on each one. */
  nurse?: boolean
}) {
  const { t } = useTranslation()
  const ops = useDeskOps()
  // every open task of this visit, including the ones for the nurses
  const { data: mine = [] } = useVisitTasks(encounterId)
  const [title, setTitle] = useState('')
  const [time, setTime] = useState(inAnHour)
  // '' = all the nurses; otherwise the one nurse it is for (0131), or me: I do it myself (0133)
  const [forWhom, setForWhom] = useState('')
  const myId = useSession((st) => st.user?.id)
  const self = !!myId && forWhom === myId
  const { data: nurses = [] } = useOrderNurses(!nurse)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [kept, setKept] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const act = (fn: () => Promise<unknown>) => {
    setError(null)
    setSaved(false)
    fn().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }
  const confirm = useConfirm()
  const name = patientName || t('confirm.visit.thisPatient')
  const cancel = async (
    id: string,
    task: string,
    key: 'ops.tasks.withdrawWhy' | 'ops.tasks.notDoneWhy',
  ) => {
    const withdraw = key === 'ops.tasks.withdrawWhy'
    // one box: the question, the reason and the yes button together
    const r = await confirm({
      title: t(withdraw ? 'confirm.visit.taskWithdraw' : 'confirm.visit.taskNotDone', { task }),
      body: t(withdraw ? 'confirm.visit.taskWithdrawBody' : 'confirm.visit.taskNotDoneBody'),
      input: { label: t(key), required: true, multiline: true },
      confirmLabel: t(withdraw ? 'confirm.visit.taskWithdrawYes' : 'confirm.visit.taskNotDoneYes'),
      tone: 'danger',
    })
    if (r.ok) act(() => ops.cancelTask.mutateAsync({ id, reason: r.value }))
  }
  const done = async (id: string, task: string) => {
    if (
      !(await confirm({
        title: t('confirm.visit.taskDone', { task }),
        body: t('confirm.visit.taskDoneBody'),
        confirmLabel: t('confirm.visit.taskDoneYes'),
      }))
    )
      return
    act(() => ops.completeTask.mutateAsync(id))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setSaved(false)
    let dueAt: string | null = null
    const m = time.match(/^(\d{1,2}):(\d{2})$/)
    if (m) {
      const d = new Date()
      d.setHours(Number(m[1]), Number(m[2]), 0, 0)
      dueAt = d.toISOString()
    }
    const one = forWhom ? nurses.find((n) => n.id === forWhom) : undefined
    if (
      !(await confirm({
        title: t('confirm.visit.taskSend', { task: title.trim(), name }),
        body: self
          ? t('ops.tasks.keepBody')
          : one
            ? t('ops.tasks.sentToOne', { name: one.name })
            : t('confirm.visit.taskSendBody'),
        confirmLabel: t(self ? 'ops.tasks.keepYes' : 'confirm.visit.taskSendYes'),
      }))
    )
      return
    try {
      await ops.createTask.mutateAsync({ encounterId, title, dueAt, assignedTo: forWhom || null })
      setTitle('')
      setSentTo(one?.name ?? null)
      setKept(self)
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // the nurse sees the card only when something waits for her on this visit
  if (nurse && mine.length === 0) return null
  return (
    <Card>
      <CardHeader hue="mint">
        <span className="inline-flex items-center gap-2">
          <ClipboardList size={16} aria-hidden="true" />
          {t('ops.tasks.forNurse')}
        </span>
        <span className="text-ink-3 text-xs">{t('ops.tasks.open', { count: mine.length })}</span>
      </CardHeader>
      {nurse && error && (
        <CardBody>
          <p className="bg-red-bg text-red border-red/30 m-0 rounded-md border px-3 py-2 text-[13px] font-semibold">
            {error}
          </p>
        </CardBody>
      )}
      {!nurse && (
        <form onSubmit={submit}>
          <CardBody className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[2fr_1fr_auto]">
            <NurseRecipient
              value={forWhom}
              onChange={setForWhom}
              selfId={myId}
              className="col-span-full"
            />
            <Field
              label={t('ops.tasks.what')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('ops.tasks.whatPh')}
              required
            />
            <Field
              label={t('ops.tasks.when')}
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
            <Button type="submit" variant="primary" loading={ops.createTask.isPending}>
              {t(self ? 'ops.tasks.keep' : 'ops.tasks.send')}
            </Button>
            {(error || saved) && (
              <p
                className={
                  error
                    ? 'bg-red-bg text-red col-span-full m-0 rounded-md px-3 py-2 text-[13px] font-semibold'
                    : 'text-green col-span-full m-0 text-[13px] font-semibold'
                }
              >
                {error ??
                  (kept
                    ? t('ops.tasks.kept')
                    : sentTo
                      ? t('ops.tasks.sentToOne', { name: sentTo })
                      : t('ops.tasks.sent'))}
              </p>
            )}
          </CardBody>
        </form>
      )}
      {mine.map((x) => (
        <Row key={x.id} className="gap-3 py-2 text-[13px]">
          <span
            className={
              x.overdue ? 'text-red font-semibold tabular-nums' : 'text-ink-2 tabular-nums'
            }
          >
            {x.dueAt ? formatTime(new Date(x.dueAt)) : '—'}
          </span>
          <span className="flex-1">
            {x.title}
            <span className="text-ink-3 block text-xs">
              {[
                x.by && t('ops.tasks.by', { name: x.by }),
                x.forMe
                  ? t('ops.tasks.forMe')
                  : x.forName
                    ? t('ops.tasks.forOne', { name: x.forName })
                    : t('ops.tasks.forAll'),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
          {nurse ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void cancel(x.id, x.title, 'ops.tasks.notDoneWhy')}
              >
                {t('ops.tasks.notDone')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                loading={ops.completeTask.isPending}
                onClick={() => void done(x.id, x.title)}
              >
                {t('common.done')}
              </Button>
            </>
          ) : (
            <>
              {!x.forMe && (
                <span className="text-ink-3 text-xs">{t('ops.tasks.waitingNurse')}</span>
              )}
              {/* the doctor who gave it, or kept it for himself, does it himself (0133) */}
              {(x.mine || x.forMe) && (
                <Button
                  size="sm"
                  variant={x.forMe ? 'primary' : 'success'}
                  loading={ops.completeTask.isPending}
                  onClick={() => void done(x.id, x.title)}
                >
                  {t(x.forMe ? 'common.done' : 'ops.tasks.didIt')}
                </Button>
              )}
              {x.mine && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void cancel(x.id, x.title, 'ops.tasks.withdrawWhy')}
                >
                  {t('ops.tasks.withdraw')}
                </Button>
              )}
            </>
          )}
        </Row>
      ))}
    </Card>
  )
}
