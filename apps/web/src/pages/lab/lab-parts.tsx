import { useState, type CSSProperties } from 'react'
import {
  CircleCheck,
  Clock,
  FlaskConical,
  Hourglass,
  Siren,
  TestTube,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime } from '@mmc/shared'
import { Pill } from '@/components/dash/kit'
import type { Tint } from '@/components/dash/kit-style'
import { Button, buttonVariants } from '@/components/ui/button'
import { StaffLink } from '@/components/staff/staff-link'
import { useLabActions, type LabOrder, type TestStatus } from '@/lib/api/lab'
import { cn } from '@/lib/utils'

const STATUS_LOOK: Record<TestStatus, { tint: Tint; icon: LucideIcon }> = {
  ordered: { tint: 'amber', icon: Hourglass },
  collected: { tint: 'teal', icon: TestTube },
  in_process: { tint: 'violet', icon: FlaskConical },
  resulted: { tint: 'navy', icon: Clock },
  verified: { tint: 'mint', icon: CircleCheck },
  cancelled: { tint: 'coral', icon: Siren },
}

const ageOf = (birth: string | null) => {
  if (!birth) return ''
  const b = new Date(birth)
  const now = new Date()
  let y = now.getFullYear() - b.getFullYear()
  if (now < new Date(now.getFullYear(), b.getMonth(), b.getDate())) y -= 1
  return String(y)
}
const minutesSince = (iso: string, now: number) =>
  Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000))
const when = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`

/**
 * One test on the bench: priority, patient, test and why, who ordered it and how long ago, the
 * status, and the next step (sample taken → enter result → verify) with the visit one click away.
 */
export function LabOrderRow({
  order: o,
  i = 0,
  now,
}: {
  order: LabOrder
  i?: number
  now: number
}) {
  const { t } = useTranslation()
  const actions = useLabActions()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    findings: o.findings ?? '',
    impression: o.impression ?? '',
    verify: true,
  })
  const [error, setError] = useState<string | null>(null)
  const look = STATUS_LOOK[o.status]
  const urgent = o.priority <= 2
  const run = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
      setOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const sexLetter = o.sex === 'female' ? 'F' : o.sex === 'male' ? 'M' : ''
  return (
    <div
      className={cn(
        'border-grid anim-enter flex flex-col gap-2 border-b py-3 last:border-b-0',
        urgent && o.status !== 'verified' && 'bg-red-bg/40 -mx-2 rounded-lg px-2',
      )}
      style={{ '--i': Math.min(i, 12) } as CSSProperties}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Pill tint={urgent ? 'coral' : 'teal'} icon={urgent ? Siren : FlaskConical}>
          {o.ticket ?? '—'}
        </Pill>
        <span className="min-w-[180px] flex-1">
          <span className="block font-semibold">
            {o.test}
            <span className="text-ink-2 font-normal"> · {o.patient}</span>
          </span>
          <span className="text-ink-3 block text-[13px]">
            {[
              [ageOf(o.birthDate), sexLetter].filter(Boolean).join(' '),
              o.fileNumber,
              o.reason,
              o.orderedBy ? t('lab.orderedBy', { name: o.orderedBy }) : null,
              o.status === 'verified' || o.status === 'resulted'
                ? null
                : t('lab.waitingFor', { count: minutesSince(o.orderedAt, now) }),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        <Pill tint={look.tint} icon={look.icon}>
          {t(`lab.status.${o.status}`)}
        </Pill>
        <span className="flex flex-wrap gap-1">
          {o.status === 'ordered' && (
            <Button
              size="sm"
              variant="primary"
              loading={actions.setStatus.isPending && actions.setStatus.variables?.id === o.id}
              onClick={() =>
                void run(() => actions.setStatus.mutateAsync({ id: o.id, status: 'collected' }))
              }
            >
              <TestTube size={14} aria-hidden="true" />
              {t('lab.sampleTaken')}
            </Button>
          )}
          {o.status !== 'verified' && o.status !== 'cancelled' && !open && (
            <Button
              size="sm"
              variant={o.status === 'ordered' ? 'default' : 'primary'}
              onClick={() => setOpen(true)}
            >
              <FlaskConical size={14} aria-hidden="true" />
              {t(o.status === 'resulted' ? 'lab.verify' : 'lab.enterResult')}
            </Button>
          )}
          <StaffLink
            to="/app/visit"
            search={{ encounter: o.encounterId }}
            className={buttonVariants({ size: 'sm', variant: 'ghost' })}
          >
            {t('visits.openVisit')}
          </StaffLink>
        </span>
      </div>
      {(o.findings || o.impression) && !open && (
        <span className="bg-green-bg/60 block rounded-lg px-3 py-2 text-[13px]">
          {o.findings && <span className="block">{o.findings}</span>}
          {o.impression && <span className="block font-semibold">{o.impression}</span>}
          {o.resultBy && o.resultAt && (
            <span className="text-ink-3 block text-xs">
              {[
                o.verified ? t('clinical.verified') : t('clinical.notVerified'),
                o.resultBy,
                when(o.resultAt),
              ].join(' · ')}
            </span>
          )}
        </span>
      )}
      {open && (
        <form
          className="bg-surface flex flex-col gap-2 rounded-xl p-3"
          onSubmit={(e) => {
            e.preventDefault()
            void run(() => actions.result.mutateAsync({ id: o.id, ...form }))
          }}
        >
          <label className="text-ink-2 flex flex-col gap-1 text-[13px] font-semibold">
            {t('clinical.findings')}
            <textarea
              rows={2}
              autoFocus
              className="border-border bg-card rounded-lg border px-2.5 py-2 text-[14px] font-normal"
              value={form.findings}
              onChange={(e) => setForm({ ...form, findings: e.target.value })}
            />
          </label>
          <label className="text-ink-2 flex flex-col gap-1 text-[13px] font-semibold">
            {t('clinical.impression')}
            <input
              className="border-border bg-card h-10 rounded-lg border px-2.5 text-[14px] font-normal"
              value={form.impression}
              onChange={(e) => setForm({ ...form, impression: e.target.value })}
            />
          </label>
          <label className="flex items-center gap-2 text-[13px] font-semibold">
            <input
              type="checkbox"
              className="accent-primary size-4"
              checked={form.verify}
              onChange={(e) => setForm({ ...form, verify: e.target.checked })}
            />
            {t('clinical.verifyNow')}
          </label>
          <span className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="primary" loading={actions.result.isPending}>
              <CircleCheck size={14} aria-hidden="true" />
              {t('clinical.saveResult')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {t('staff.form.cancel')}
            </Button>
          </span>
        </form>
      )}
      {error && (
        <p className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold">
          {error}
        </p>
      )}
    </div>
  )
}
