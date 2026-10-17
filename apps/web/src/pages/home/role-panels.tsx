import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatRwf, type ApptStatus, type HomeRole, type Tone } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardHeader, Row } from '@/components/ui/card'
import { StaffLink } from '@/components/staff/staff-link'
import { useHomeActions, useHomeSummary, type HomeBed, type HomeSummary } from '@/lib/api/home'
import { cn } from '@/lib/utils'

const apptTone: Record<ApptStatus, Tone> = { arrived: 'green', due: 'blue', late: 'red' }
const bedClass: Record<HomeBed['state'], string> = {
  occupied: 'bg-hover text-ink',
  free: 'bg-green-bg text-green',
  cleaning: 'bg-yellow-bg text-yellow',
  out_of_service: 'bg-red-bg text-red',
}

/** Zone 2 of the home page: what this role must do next, live from `home_summary()`. */
export function RolePanels({ role, empty }: { role: HomeRole; empty: boolean }) {
  const { data, error } = useHomeSummary()
  const [actionError, setActionError] = useState<string | null>(null)
  if (error) return <ErrorBox>{error.message}</ErrorBox>
  if (!data) return null
  const common = { data, onError: setActionError }
  return (
    <>
      {actionError && <ErrorBox>{actionError}</ErrorBox>}
      {role === 'receptionist' && <ReceptionistPanels {...common} empty={empty} />}
      {role === 'nurse' && <NursePanels {...common} />}
      {role === 'doctor' && <DoctorPanels {...common} />}
      {role === 'cashier' && <CashierPanels {...common} />}
    </>
  )
}

interface PanelProps {
  data: HomeSummary
  onError: (m: string | null) => void
}

/** First card grows and scrolls on PC; everything stacks and scrolls as a page on tablets. */
const grow = 'pc:min-h-0 pc:flex-1 pc:overflow-hidden'
const scroll = 'pc:overflow-auto'

function ErrorBox({ children }: { children: string }) {
  return (
    <p
      role="alert"
      className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
    >
      {children}
    </p>
  )
}
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))

function ReceptionistPanels({ data, onError, empty }: PanelProps & { empty: boolean }) {
  const { t } = useTranslation()
  const actions = useHomeActions()
  const appts = empty ? [] : data.appointments
  const counts = {
    arrived: appts.filter((a) => a.status === 'arrived').length,
    due: appts.filter((a) => a.status === 'due').length,
    late: appts.filter((a) => a.status === 'late').length,
  }
  const approve = async (id: string) => {
    onError(null)
    try {
      await actions.approveInquiry.mutateAsync({ id })
    } catch (e) {
      onError(t('home.inquiryApproveFailed', { message: describe(e) }))
    }
  }
  const reject = async (id: string) => {
    const reason = window.prompt(t('home.inquiryRejectReason'))
    if (!reason) return
    onError(null)
    try {
      await actions.rejectInquiry.mutateAsync({ id, reason })
    } catch (e) {
      onError(describe(e))
    }
  }
  return (
    <>
      <Card className={grow}>
        <CardHeader className="flex-wrap">
          <span>{t('home.todaysAppointments')}</span>
          <span className="flex gap-1.5 tabular-nums">
            <Badge tone="green">{t('home.arrived', { count: counts.arrived })}</Badge>
            <Badge tone="blue">{t('home.due', { count: counts.due })}</Badge>
            <Badge tone="red">{t('home.late', { count: counts.late })}</Badge>
          </span>
        </CardHeader>
        {appts.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-6 text-center">
            <div className="text-base font-semibold">{t('home.noAppointmentsTitle')}</div>
            <div className="text-ink-2">{t('home.noAppointmentsBody')}</div>
          </div>
        ) : (
          <div className={scroll}>
            {appts.map((a) => (
              <Row key={a.id}>
                <span className="text-ink-2 w-11 tabular-nums">{a.time}</span>
                <span className="min-w-0 flex-1">
                  <span className="font-semibold">{a.name}</span>
                  <span className="text-ink-3 block text-xs">
                    {a.doctor}
                    {a.station ? ` · ${a.station}` : ''}
                  </span>
                </span>
                <Badge tone={apptTone[a.status]}>{t(`home.apptStatus.${a.status}`)}</Badge>
              </Row>
            ))}
          </div>
        )}
      </Card>
      <Card className="flex-none">
        <CardHeader>
          <span>{t('home.inquiries')}</span>
          <Badge tone={data.inquiries.length ? 'yellow' : 'green'} className="tabular-nums">
            {t('home.pending', { count: data.inquiries.length })}
          </Badge>
        </CardHeader>
        {data.inquiries.length === 0 && (
          <Row>
            <span className="text-ink-3 text-[13px]">{t('home.noInquiries')}</span>
          </Row>
        )}
        {data.inquiries.map((i) => (
          <Row key={i.id} className="flex-wrap">
            <span className="min-w-[140px] flex-1">
              <span className="font-semibold">{i.name}</span>
              <span className="text-ink-3 block text-xs">
                {[i.category && t(`categories.${i.category}`), i.doctor, i.when, i.phone, i.note]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
            <span className="flex gap-2">
              <Button
                variant="primary"
                size="sm"
                disabled={actions.approveInquiry.isPending}
                onClick={() => void approve(i.id)}
              >
                {t('common.approve')}
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={actions.rejectInquiry.isPending}
                onClick={() => void reject(i.id)}
              >
                {t('common.reject')}
              </Button>
            </span>
          </Row>
        ))}
      </Card>
    </>
  )
}

function NursePanels({ data, onError }: PanelProps) {
  const { t } = useTranslation()
  const actions = useHomeActions()
  const occupied = data.beds.filter((b) => b.state === 'occupied').length
  const free = data.beds.filter((b) => b.state === 'free').length
  const done = async (id: string) => {
    onError(null)
    try {
      await actions.completeTask.mutateAsync({ id })
    } catch (e) {
      onError(describe(e))
    }
  }
  return (
    <>
      <Card className={grow}>
        <CardHeader>
          <span>{t('home.tasksDue')}</span>
          <Badge
            tone={data.tasks.some((x) => x.overdue) ? 'red' : 'green'}
            className="tabular-nums"
          >
            {t('home.overdue', { count: data.tasks.filter((x) => x.overdue).length })}
          </Badge>
        </CardHeader>
        <div className={scroll}>
          {data.tasks.length === 0 && (
            <Row>
              <span className="text-ink-3 text-[13px]">{t('home.noTasks')}</span>
            </Row>
          )}
          {data.tasks.map((task) => (
            <Row key={task.id}>
              <span
                className={cn(
                  'w-11 font-semibold tabular-nums',
                  task.overdue ? 'text-red' : 'text-ink',
                )}
              >
                {task.time ?? '—'}
              </span>
              <span className="min-w-0 flex-1">
                <span className="font-semibold">{task.title}</span>
                <span className="text-ink-3 block text-xs">
                  {[task.patient, task.detail].filter(Boolean).join(' · ')}
                </span>
              </span>
              <Button size="sm" onClick={() => void done(task.id)}>
                {t('common.done')}
              </Button>
            </Row>
          ))}
        </div>
      </Card>
      <Card className="flex-none">
        <CardHeader>
          <span>{t('home.bedBoard')}</span>
          <span className="text-ink-2 tabular-nums">
            {t('home.bedSummary', { occupied, free })}
          </span>
        </CardHeader>
        <div className="grid grid-cols-4 gap-2 px-4 py-3">
          {data.beds.map((b) => (
            <div
              key={b.name}
              className={cn(
                'border-border min-h-[52px] rounded-lg border px-2 py-1.5 text-xs',
                bedClass[b.state],
              )}
            >
              <span className="block font-bold">{b.name}</span>
              <span>{b.state === 'occupied' ? (b.who ?? '') : t(`home.bedState.${b.state}`)}</span>
            </div>
          ))}
        </div>
      </Card>
    </>
  )
}

function DoctorPanels({ data, onError }: PanelProps) {
  const { t } = useTranslation()
  const actions = useHomeActions()
  const mine = data.appointments.filter((a) => a.mine)
  const accept = async (id: string) => {
    onError(null)
    try {
      await actions.acceptAppointment.mutateAsync({ id })
    } catch (e) {
      onError(describe(e))
    }
  }
  const decline = async (id: string) => {
    const reason = window.prompt(t('home.declineReason'))
    if (!reason) return
    onError(null)
    try {
      await actions.declineAppointment.mutateAsync({ id, reason })
    } catch (e) {
      onError(describe(e))
    }
  }
  return (
    <>
      <Card className={grow}>
        <CardHeader>
          <span>{t('home.resultsInbox')}</span>
          <Badge
            tone={data.results.some((r) => !r.verified) ? 'yellow' : 'green'}
            className="tabular-nums"
          >
            {t('home.resultsCount', { count: data.results.length })}
          </Badge>
        </CardHeader>
        <div className={scroll}>
          {data.results.length === 0 && (
            <Row>
              <span className="text-ink-3 text-[13px]">{t('home.noResults')}</span>
            </Row>
          )}
          {data.results.map((r) => (
            <Row key={r.id}>
              <Badge tone={r.verified ? 'green' : 'yellow'} className="w-[88px] justify-start">
                {t(r.verified ? 'home.verified' : 'home.unverified')}
              </Badge>
              <span className="min-w-0 flex-1">
                <span className="font-semibold">
                  {r.test} · {r.name}
                </span>
                <span className="text-ink-3 block text-xs tabular-nums">
                  {r.impression} · {r.at}
                </span>
              </span>
              <StaffLink
                to="/app/visit"
                search={{ encounter: r.encounterId }}
                className={buttonVariants({ size: 'sm' })}
              >
                {t('common.open')}
              </StaffLink>
            </Row>
          ))}
        </div>
      </Card>
      <div className="grid flex-none grid-cols-1 gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <span>{t('home.todaysCalendar')}</span>
          </CardHeader>
          {mine.length === 0 && (
            <Row className="min-h-10 py-1.5">
              <span className="text-ink-3 text-[13px]">{t('home.noCalendar')}</span>
            </Row>
          )}
          {mine.map((c) => (
            <Row key={c.id} className="min-h-10 py-1.5">
              <span className="text-ink-2 w-11 tabular-nums">{c.time}</span>
              <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
              <Badge tone={apptTone[c.status]}>{t(`home.apptStatus.${c.status}`)}</Badge>
            </Row>
          ))}
        </Card>
        <Card>
          <CardHeader>
            <span>{t('home.inquiriesToAccept')}</span>
          </CardHeader>
          {data.toAccept.length === 0 && (
            <Row className="min-h-10 py-1.5">
              <span className="text-ink-3 text-[13px]">{t('home.nothingToAccept')}</span>
            </Row>
          )}
          {data.toAccept.map((q) => (
            <Row key={q.id} className="flex-col items-stretch gap-2">
              <span>
                <span className="font-semibold">{q.name}</span>
                <span className="text-ink-3 block text-xs">
                  {[q.when, q.note].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className="flex gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  className="flex-1"
                  onClick={() => void accept(q.id)}
                >
                  {t('common.accept')}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  className="flex-1"
                  onClick={() => void decline(q.id)}
                >
                  {t('common.decline')}
                </Button>
              </span>
            </Row>
          ))}
        </Card>
      </div>
    </>
  )
}

function CashierPanels({ data }: PanelProps) {
  const { t } = useTranslation()
  const due = data.openBills.reduce((s, b) => s + b.balance, 0)
  return (
    <>
      <Card className={grow}>
        <CardHeader>
          <span>{t('home.openBills')}</span>
          <span className="text-ink-2 tabular-nums">
            {t('home.billsDue', { count: data.openBills.length, amount: formatRwf(due) })}
          </span>
        </CardHeader>
        <div className={scroll}>
          {data.openBills.length === 0 && (
            <Row>
              <span className="text-ink-3 text-[13px]">{t('home.noOpenBills')}</span>
            </Row>
          )}
          {data.openBills.map((b) => (
            <Row key={b.encounterId}>
              <span className="min-w-0 flex-1">
                <span className="font-semibold">
                  {b.ticket ? `${b.ticket} · ` : ''}
                  {b.name}
                </span>
                <span className="text-ink-3 block text-xs">
                  {b.file}
                  {b.station
                    ? ` · ${t('home.atStation', { station: t(`register.stations.${b.station}`) })}`
                    : ''}
                </span>
              </span>
              <span className="w-[104px] text-right font-semibold tabular-nums">
                {formatRwf(b.balance)}
              </span>
              <StaffLink
                to="/app/visit"
                search={{ encounter: b.encounterId }}
                className={buttonVariants({ variant: 'primary', size: 'sm' })}
              >
                {t('home.takePayment')}
              </StaffLink>
            </Row>
          ))}
        </div>
      </Card>
      <Card className="flex-none">
        <CardHeader>
          <span>{t('home.paidToday')}</span>
          <Badge tone="green" className="tabular-nums">
            {t('home.paymentsCount', { count: data.paidToday.count })}
          </Badge>
        </CardHeader>
        <Row className="min-h-10 py-1.5">
          <span className="flex-1 font-medium">{t('home.collectedToday')}</span>
          <span className="text-ink text-lg font-bold tabular-nums">
            {formatRwf(data.paidToday.amount)}
          </span>
        </Row>
      </Card>
    </>
  )
}
