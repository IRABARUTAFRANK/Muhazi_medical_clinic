import { useState, type CSSProperties } from 'react'
import {
  BellRing,
  Check,
  FolderOpen,
  HandHelping,
  PhoneCall,
  Send,
  UserRound,
  X,
} from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { Panel } from '@/components/dash/kit'
import { Button, buttonVariants } from '@/components/ui/button'
import { Flash } from '@/components/ui/flash'
import { StaffLink } from '@/components/staff/staff-link'
import { useCallActions, useMyCalls, type StaffCall } from '@/lib/api/calls'
import { useColleagues } from '@/lib/api/referrals'
import { stationFor, useQueueBoard, type QueueItem } from '@/lib/api/visits'
import { formatDuration } from '@/lib/duration'
import { cn } from '@/lib/utils'

const control =
  'border-border bg-card text-ink focus:border-primary h-10 w-full rounded-lg border px-2.5 text-[14px] outline-none'
const row = 'border-border flex flex-col gap-2 rounded-xl border px-3 py-2.5'
const minutesSince = (iso: string) =>
  Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))

/** Desks that receive patients and may call the next one. */
const CALLERS = ['doctor', 'nurse', 'sonographer', 'lab_tech']

/**
 * Calls between colleagues, on the home page:
 *  - a doctor (or any desk) finished with a patient calls the next one, from reception, from the
 *    nurses or from one colleague;
 *  - reception (or the nurses, or that colleague) sees the call and sends a waiting patient;
 *  - help requests on a patient: open the file, accept (you may then work on the patient) or
 *    decline; the patients you help on stay listed until the help ends.
 */
export function CallsPanel({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { data: calls } = useMyCalls(user.role)
  const actions = useCallActions()
  const { data: colleagues = [] } = useColleagues()
  const incomingNext = (calls?.incoming ?? []).filter((c) => c.kind === 'next')
  const incomingHelp = (calls?.incoming ?? []).filter((c) => c.kind === 'help')
  const myNext = (calls?.mine ?? []).filter((c) => c.kind === 'next')
  const helping = calls?.helping ?? []
  // Waiting patients reception or the nurse can send (only fetched when someone calls).
  const { data: queue = [] } = useQueueBoard('all', user.role)
  const [target, setTarget] = useState<'reception' | 'nurse' | 'person'>('reception')
  const [toUser, setToUser] = useState('')
  const [note, setNote] = useState('')
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const caller = CALLERS.includes(user.role)
  const myStation = stationFor(user)
  const desk = (s: string | null) => (s ? t(`register.stations.${s}`, { defaultValue: s }) : '')

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

  // Patients one may send to the caller: waiting, nobody has them yet; the caller's desk first.
  const waitingFor = (c: StaffCall): QueueItem[] =>
    queue
      .filter(
        (q) =>
          !q.finishedAt &&
          !q.startedAt &&
          !q.takenBy &&
          (!q.assignedTo || q.assignedTo === c.fromId) &&
          // waiting for a doctor, at triage or reception (not in the middle of a test or care)
          (q.station === c.station ||
            ['triage', 'reception', 'consultation', 'dental'].includes(q.station)),
      )
      .sort(
        (a, b) =>
          Number(b.station === c.station) - Number(a.station === c.station) ||
          a.priority - b.priority ||
          a.queuedAt.localeCompare(b.queuedAt),
      )

  const open = myNext.find((c) => c.status === 'open')
  const answered = myNext.filter((c) => c.status === 'answered')
  const nothing =
    !caller && incomingNext.length === 0 && incomingHelp.length === 0 && helping.length === 0
  // keep the panel while its last message shows (e.g. "sent to Dr X" after the only call)
  if (nothing && !notice && !error) return null

  return (
    <Panel i={1} icon={BellRing} tint="violet" title={t('calls.title')}>
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

      {/* Calls for me: send a waiting patient to the colleague who called */}
      {incomingNext.map((c, i) => {
        const options = waitingFor(c)
        const choice = picked[c.id] ?? options[0]?.queueId ?? ''
        return (
          <div
            key={c.id}
            className={cn(row, 'border-violet/40 bg-violet-bg/50 anim-enter')}
            style={{ '--i': i } as CSSProperties}
          >
            <span className="inline-flex flex-wrap items-center gap-x-2 text-[14px]">
              <PhoneCall size={16} aria-hidden="true" className="text-violet" />
              <b>{t('calls.next.incoming', { name: c.fromName, desk: desk(c.station) })}</b>
              <span className="text-ink-3 text-[13px]">
                {formatDuration(minutesSince(c.at), t)}
              </span>
            </span>
            {c.note && <span className="text-ink-2 text-[13px]">“{c.note}”</span>}
            {options.length === 0 ? (
              <span className="text-ink-3 text-[13px]">{t('calls.next.noneWaiting')}</span>
            ) : (
              <span className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-[13px] font-semibold">
                  {t('calls.next.pick')}
                  <select
                    className={control}
                    value={choice}
                    onChange={(e) => setPicked((p) => ({ ...p, [c.id]: e.target.value }))}
                  >
                    {options.map((q) => (
                      <option key={q.queueId} value={q.queueId}>
                        {q.ticket} · {q.name} · {desk(q.station)} · {formatDuration(q.waitMin, t)}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  variant="primary"
                  disabled={!choice || actions.answer.isPending}
                  onClick={() =>
                    void run(
                      () => actions.answer.mutateAsync({ callId: c.id, queueId: choice }),
                      t('calls.next.sent', {
                        patient: options.find((q) => q.queueId === choice)?.name ?? '',
                        name: c.fromName,
                      }),
                    )
                  }
                >
                  <Send size={16} aria-hidden="true" />
                  {t('calls.next.send', { name: c.fromName })}
                </Button>
              </span>
            )}
          </div>
        )
      })}

      {/* Help requests for me */}
      {incomingHelp.map((c) => (
        <div key={c.id} className={cn(row, 'border-red/30 bg-red-bg/40')}>
          <span className="inline-flex flex-wrap items-center gap-x-2 text-[14px]">
            <HandHelping size={16} aria-hidden="true" className="text-red" />
            <b>
              {t('calls.help.incoming', {
                name: c.fromName,
                patient: `${c.patientName ?? ''}${c.ticket ? ` (${c.ticket})` : ''}`,
              })}
            </b>
            <span className="text-ink-3 text-[13px]">{formatDuration(minutesSince(c.at), t)}</span>
          </span>
          {c.note && <span className="text-ink-2 text-[13px]">“{c.note}”</span>}
          <span className="flex flex-wrap gap-2">
            {c.encounterId && (
              <StaffLink
                to="/app/visit"
                search={{ encounter: c.encounterId }}
                className={buttonVariants({ size: 'sm' })}
              >
                <FolderOpen size={14} aria-hidden="true" />
                {t('calls.help.look')}
              </StaffLink>
            )}
            <Button
              size="sm"
              variant="primary"
              disabled={actions.respond.isPending}
              onClick={() =>
                void run(
                  async () => {
                    await actions.respond.mutateAsync({ callId: c.id, accept: true })
                    if (c.encounterId)
                      await navigate({ to: '/app/visit', search: { encounter: c.encounterId } })
                  },
                  t('calls.help.accepted', { name: c.fromName }),
                )
              }
            >
              <Check size={14} aria-hidden="true" />
              {t('calls.help.accept')}
            </Button>
            {c.target === 'person' && (
              <Button
                size="sm"
                variant="ghost"
                disabled={actions.respond.isPending}
                onClick={() =>
                  void run(
                    () => actions.respond.mutateAsync({ callId: c.id, accept: false }),
                    t('calls.help.declined', { name: c.fromName }),
                  )
                }
              >
                <X size={14} aria-hidden="true" />
                {t('calls.help.decline')}
              </Button>
            )}
          </span>
        </div>
      ))}

      {/* Patients I help on */}
      {helping.map((c) => (
        <div key={c.id} className={cn(row, 'flex-row flex-wrap items-center')}>
          <HandHelping size={16} aria-hidden="true" className="text-primary" />
          <span className="min-w-[180px] flex-1 text-[14px]">
            {t('calls.help.youHelp', { name: c.fromName, patient: c.patientName ?? '' })}
          </span>
          {c.encounterId && (
            <StaffLink
              to="/app/visit"
              search={{ encounter: c.encounterId }}
              className={buttonVariants({ size: 'sm' })}
            >
              {t('common.open')}
            </StaffLink>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void run(() => actions.cancel.mutateAsync(c.id), t('calls.help.ended'))}
          >
            {t('calls.help.endMine')}
          </Button>
        </div>
      ))}

      {/* Call the next patient */}
      {caller && (
        <div className="flex flex-col gap-2">
          {open ? (
            <div className={cn(row, 'border-primary/40 bg-primary-tint/40')}>
              <span className="inline-flex flex-wrap items-center gap-2 text-[14px] font-semibold">
                <PhoneCall size={16} aria-hidden="true" className="text-primary" />
                {t(`calls.next.waiting.${open.target}`, { name: open.toName ?? '' })}
                <span className="text-ink-3 text-[13px] font-normal">
                  {formatDuration(minutesSince(open.at), t)}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="self-start"
                disabled={actions.cancel.isPending}
                onClick={() =>
                  void run(() => actions.cancel.mutateAsync(open.id), t('calls.next.cancelled'))
                }
              >
                <X size={14} aria-hidden="true" />
                {t('calls.next.cancel')}
              </Button>
            </div>
          ) : (
            <>
              <span className="text-[14px] font-semibold">{t('calls.next.title')}</span>
              <span className="text-ink-3 text-[13px]">{t('calls.next.lead')}</span>
              <div className="flex flex-wrap gap-2" role="radiogroup">
                {(['reception', 'nurse', 'person'] as const).map((x) => (
                  <Button
                    key={x}
                    size="sm"
                    role="radio"
                    aria-checked={target === x}
                    variant={target === x ? 'primary' : 'default'}
                    onClick={() => setTarget(x)}
                  >
                    {x === 'person' && <UserRound size={14} aria-hidden="true" />}
                    {t(`calls.next.from.${x}`)}
                  </Button>
                ))}
              </div>
              {target === 'person' && (
                <select
                  className={control}
                  value={toUser}
                  onChange={(e) => setToUser(e.target.value)}
                  aria-label={t('calls.next.colleague')}
                >
                  <option value="">{t('calls.next.colleague')}</option>
                  {colleagues
                    .filter((c) => c.id !== user.id)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} · {t(`staff.roles.${c.role}`, { defaultValue: c.role })}
                      </option>
                    ))}
                </select>
              )}
              <input
                className={control}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t('calls.next.notePh')}
                aria-label={t('calls.next.notePh')}
              />
              <Button
                variant="primary"
                className="self-start"
                disabled={actions.callNext.isPending || (target === 'person' && !toUser)}
                onClick={() =>
                  void run(async () => {
                    await actions.callNext.mutateAsync({
                      station: myStation,
                      target,
                      toUser: target === 'person' ? toUser : null,
                      note,
                    })
                    setNote('')
                  }, t('calls.next.called'))
                }
              >
                <PhoneCall size={16} aria-hidden="true" />
                {t('calls.next.call')}
              </Button>
            </>
          )}
          {answered.map((c) => (
            <span
              key={c.id}
              className="text-green inline-flex flex-wrap items-center gap-2 text-[13px] font-semibold"
            >
              <Check size={14} aria-hidden="true" />
              {t('calls.next.answered', {
                name: c.answeredName ?? '',
                patient: `${c.patientName ?? ''}${c.ticket ? ` (${c.ticket})` : ''}`,
              })}
              {c.encounterId && (
                <StaffLink
                  to="/app/visit"
                  search={{ encounter: c.encounterId }}
                  className={buttonVariants({ size: 'sm' })}
                >
                  {t('common.open')}
                </StaffLink>
              )}
            </span>
          ))}
        </div>
      )}
    </Panel>
  )
}
