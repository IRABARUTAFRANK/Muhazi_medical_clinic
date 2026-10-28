import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  CircleCheck,
  CircleX,
  Clock,
  FolderOpen,
  LockKeyhole,
  ShieldCheck,
  Siren,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { Hint, Panel, Pill } from '@/components/dash/kit'
import { card, type Tint } from '@/components/dash/kit-style'
import { Button } from '@/components/ui/button'
import { Flash } from '@/components/ui/flash'
import { StaffLink } from '@/components/staff/staff-link'
import {
  useRecordAccessActions,
  useRecordAccessRequests,
  type AccessRequestRow,
} from '@/lib/api/privacy'
import { useCan } from '@/lib/api/permissions'
import { useConfirm } from '@/lib/confirm'
import { useAgo } from '@/lib/notice-wording'
import { cn } from '@/lib/utils'
import { isManagerUser } from './approvers'

/*
 * Patient record privacy (0088), the approvers' side: the manager, and whoever the manager
 * allowed to in Settings → Who may do what (records.approve, 0095), answer the requests of
 * colleagues who treat the patient now (approve, or refuse with a reason; the first answer wins).
 * A head of department no longer answers by position. The manager
 * also reviews every emergency access. Used on the Record access page and on the approvers' homes.
 */

const textarea =
  'border-border bg-card text-ink focus:border-primary focus:ring-primary/20 w-full rounded-md border px-3 py-2 text-[14px] font-normal outline-none focus:ring-2'

/** At least three letters: the database refuses shorter reasons. */
const enough = (s: string) => s.trim().length >= 3

function statusLook(r: AccessRequestRow): { tint: Tint; icon: LucideIcon; key: string } {
  if (r.kind === 'emergency')
    return r.reviewedAt
      ? { tint: 'navy', icon: ShieldCheck, key: 'reviewed' }
      : { tint: 'coral', icon: Siren, key: 'toReview' }
  if (r.status === 'pending') return { tint: 'amber', icon: Clock, key: 'pending' }
  if (r.status === 'approved')
    return r.active
      ? { tint: 'mint', icon: CircleCheck, key: 'active' }
      : { tint: 'teal', icon: CircleCheck, key: 'approved' }
  if (r.status === 'refused') return { tint: 'coral', icon: CircleX, key: 'refused' }
  return { tint: 'navy', icon: CircleX, key: 'cancelled' }
}

/**
 * One request or emergency access: the patient, who asks and why, and what the reader may do
 * (approve / refuse with a reason, withdraw their own, the manager's review with a comment).
 */
export function AccessRequestCard({
  row,
  i = 0,
  highlight = false,
  compact = false,
  onDone,
}: {
  row: AccessRequestRow
  i?: number
  /** Opened from a notice (?request=<id>): scrolled into view and outlined. */
  highlight?: boolean
  /** On a home page: fewer details. */
  compact?: boolean
  /** Where a success message goes when the answered card leaves its list (the page's message). */
  onDone?: (message: string) => void
}) {
  const { t } = useTranslation()
  const ago = useAgo()
  const confirm = useConfirm()
  const actions = useRecordAccessActions()
  const [mode, setMode] = useState<'idle' | 'refuse' | 'review'>('idle')
  const [note, setNote] = useState('')
  const [flash, setFlash] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const ref = useRef<HTMLElement>(null)
  const look = statusLook(row)
  const role = t(`staff.roles.${row.requestedByRole}`, { defaultValue: row.requestedByRole })
  const names = { by: row.requestedBy, name: row.patient }
  const busy = actions.answer.isPending || actions.review.isPending || actions.cancel.isPending

  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [highlight])

  const run = async (job: () => Promise<unknown>, done: string) => {
    setFlash(null)
    try {
      await job()
      setMode('idle')
      setNote('')
      if (onDone) onDone(done)
      else setFlash({ tone: 'success', text: done })
    } catch (e) {
      setFlash({ tone: 'error', text: (e as Error).message })
    }
  }

  const approve = async () => {
    const yes = await confirm({
      title: t('recordAccess.confirm.approveTitle', names),
      body: t('recordAccess.confirm.approveBody', names),
      confirmLabel: t('recordAccess.confirm.approveYes'),
    })
    if (!yes) return
    await run(
      () => actions.answer.mutateAsync({ requestId: row.id, approve: true }),
      t('recordAccess.done.approved', names),
    )
  }
  const refuse = async () => {
    if (!enough(note)) return
    const yes = await confirm({
      title: t('recordAccess.confirm.refuseTitle', names),
      body: t('recordAccess.confirm.refuseBody', { ...names, note: note.trim() }),
      confirmLabel: t('recordAccess.confirm.refuseYes'),
      tone: 'danger',
    })
    if (!yes) return
    await run(
      () => actions.answer.mutateAsync({ requestId: row.id, approve: false, note }),
      t('recordAccess.done.refused', names),
    )
  }
  const review = async () => {
    const yes = await confirm({
      title: t('recordAccess.confirm.reviewTitle', names),
      body: t('recordAccess.confirm.reviewBody', { ...names, reason: row.reason }),
      confirmLabel: t('recordAccess.confirm.reviewYes'),
    })
    if (!yes) return
    await run(
      () => actions.review.mutateAsync({ requestId: row.id, note }),
      t('recordAccess.done.reviewed', names),
    )
  }
  const withdraw = async () => {
    const yes = await confirm({
      title: t('recordAccess.confirm.withdrawTitle', names),
      body: t('recordAccess.confirm.withdrawBody'),
      confirmLabel: t('recordAccess.confirm.withdrawYes'),
      tone: 'danger',
    })
    if (!yes) return
    await run(() => actions.cancel.mutateAsync(row.id), t('recordAccess.done.withdrawn'))
  }

  return (
    <article
      ref={ref}
      id={`request-${row.id}`}
      className={cn(
        card,
        'anim-enter gap-2 p-3',
        row.kind === 'emergency' && !row.reviewedAt && 'border-l-red-dot border-l-[3px]',
        highlight && 'border-primary ring-primary/20 ring-2',
      )}
      style={{ '--i': i } as CSSProperties}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Pill tint={look.tint} icon={look.icon}>
          {row.kind === 'emergency'
            ? t('recordAccess.status.emergency')
            : t(`recordAccess.status.${look.key}`)}
        </Pill>
        {row.kind === 'emergency' && (
          <Pill tint={look.tint}>{t(`recordAccess.status.${look.key}`)}</Pill>
        )}
        <StaffLink
          to="/app/patient"
          search={{ id: row.patientId }}
          className="text-ink hover:text-primary coarse:inline-flex coarse:min-h-[var(--tap)] coarse:items-center min-w-0 text-[14px] font-semibold no-underline"
        >
          {row.patient}
        </StaffLink>
        {row.fileNumber && (
          <span className="text-ink-3 text-[13px] tabular-nums">{row.fileNumber}</span>
        )}
        <span className="text-ink-3 ml-auto text-[13px] whitespace-nowrap">{ago(row.at)}</span>
      </div>

      <p className="text-ink-2 m-0 text-[14px]">
        {t(row.kind === 'emergency' ? 'recordAccess.card.openedBy' : 'recordAccess.card.askedBy', {
          name: row.requestedBy,
          role,
        })}
        {row.visitReference && (
          <span className="text-ink-3">
            {' · '}
            {t('recordAccess.card.visit', { ref: row.visitReference })}
            {!row.visitOpen && ` (${t('recordAccess.card.visitClosed')})`}
          </span>
        )}
      </p>
      <p className="border-border text-ink m-0 border-l-[3px] pl-2.5 text-[14px] italic">
        “{row.reason}”
      </p>

      {/* the answer, once given */}
      {row.kind === 'request' && row.answeredBy && row.status !== 'pending' && (
        <p className="text-ink-2 m-0 text-[13px]">
          {t('recordAccess.card.answeredBy', {
            status: t(`recordAccess.status.${row.status}`),
            name: row.answeredBy,
            when: row.answeredAt ? ago(row.answeredAt) : '',
          })}
          {row.answerNote && ` · ${t('recordAccess.card.why', { note: row.answerNote })}`}
        </p>
      )}
      {row.kind === 'emergency' && row.reviewedAt && (
        <p className="text-ink-2 m-0 text-[13px]">
          {t('recordAccess.card.reviewedBy', {
            name: row.reviewedBy ?? '',
            when: ago(row.reviewedAt),
          })}
          {row.reviewNote && ` · ${t('recordAccess.card.comment', { note: row.reviewNote })}`}
        </p>
      )}

      {flash && (
        <Flash key={flash.text} tone={flash.tone} onClose={() => setFlash(null)}>
          {flash.text}
        </Flash>
      )}

      {/* approve / refuse (the first approver to answer decides) */}
      {row.canAnswer && mode === 'idle' && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => void approve()}
            loading={actions.answer.isPending}
            disabled={busy}
          >
            {!actions.answer.isPending && <CircleCheck size={16} aria-hidden="true" />}
            {t('recordAccess.approve')}
          </Button>
          <Button variant="danger" size="sm" onClick={() => setMode('refuse')} disabled={busy}>
            <CircleX size={16} aria-hidden="true" />
            {t('recordAccess.refuse')}
          </Button>
          {!compact && (
            <StaffLink
              to="/app/patient"
              search={{ id: row.patientId }}
              className="text-primary inline-flex h-8 items-center gap-1.5 px-2 text-[13px] font-medium no-underline hover:underline"
            >
              <FolderOpen size={15} aria-hidden="true" />
              {t('recordAccess.card.openFile')}
            </StaffLink>
          )}
        </div>
      )}
      {row.canAnswer && mode === 'refuse' && (
        <div className="flex flex-col gap-2">
          <label className="text-ink-2 flex flex-col gap-1.5 text-[13px] font-medium">
            {t('recordAccess.refuseReason')}
            <textarea
              rows={2}
              value={note}
              autoFocus
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('recordAccess.refuseReasonPh')}
              className={textarea}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="danger"
              size="sm"
              onClick={() => void refuse()}
              disabled={!enough(note) || busy}
              loading={actions.answer.isPending}
            >
              {t('recordAccess.refuseSend')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setMode('idle')} disabled={busy}>
              {t('recordAccess.back')}
            </Button>
          </div>
        </div>
      )}

      {/* the manager's review of an emergency access */}
      {row.canReview &&
        (mode === 'review' ? (
          <div className="flex flex-col gap-2">
            <label className="text-ink-2 flex flex-col gap-1.5 text-[13px] font-medium">
              {t('recordAccess.reviewLabel')}
              <textarea
                rows={2}
                value={note}
                autoFocus
                onChange={(e) => setNote(e.target.value)}
                placeholder={t('recordAccess.reviewPh')}
                className={textarea}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void review()}
                disabled={busy}
                loading={actions.review.isPending}
              >
                {!actions.review.isPending && <ShieldCheck size={16} aria-hidden="true" />}
                {t('recordAccess.reviewMark')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setMode('idle')} disabled={busy}>
                {t('recordAccess.back')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setMode('review')} disabled={busy}>
              <ShieldCheck size={16} aria-hidden="true" />
              {t('recordAccess.reviewOpen')}
            </Button>
          </div>
        ))}

      {row.canCancel && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void withdraw()}
            disabled={busy}
            loading={actions.cancel.isPending}
          >
            {t('recordAccess.withdraw')}
          </Button>
        </div>
      )}
    </article>
  )
}

/**
 * The approvers' home block: requests waiting for their answer and (manager) emergency accesses
 * not reviewed yet. Hidden when there is nothing to do, so it costs no room on a quiet day.
 */
export function AccessApprovalsPanel({ user, i = 1 }: { user: StaffUser; i?: number }) {
  const { t } = useTranslation()
  const can = useCan(user)
  const manager = isManagerUser(user)
  const approver = manager || can('records.approve')
  const { data: pending = [] } = useRecordAccessRequests('pending', approver)
  const { data: emergencies = [] } = useRecordAccessRequests('emergency', approver && manager)
  const toReview = emergencies.filter((r) => r.canReview)
  const rows = [...toReview, ...pending]
  // kept here: the answered card leaves the list (and the block goes when nothing is left)
  const [done, setDone] = useState<string | null>(null)
  if (!approver || (rows.length === 0 && !done)) return null
  return (
    <Panel
      i={i}
      icon={LockKeyhole}
      tint={toReview.length ? 'coral' : 'amber'}
      title={t('recordAccess.homeTitle')}
      right={t('recordAccess.homeCount', { count: rows.length })}
      to="/app/record-access"
      toLabel={t('nav.recordAccess')}
    >
      <div className="flex flex-col gap-2.5">
        {done && (
          <Flash key={done} onClose={() => setDone(null)}>
            {done}
          </Flash>
        )}
        {rows.slice(0, 3).map((r, n) => (
          <AccessRequestCard key={r.id} row={r} i={n} compact onDone={setDone} />
        ))}
        {rows.length > 3 && (
          <StaffLink
            to="/app/record-access"
            className="text-primary text-[13px] font-medium no-underline hover:underline"
          >
            {t('recordAccess.homeMore', { count: rows.length - 3 })}
          </StaffLink>
        )}
        <Hint>{t('recordAccess.pendingHint')}</Hint>
      </div>
    </Panel>
  )
}
