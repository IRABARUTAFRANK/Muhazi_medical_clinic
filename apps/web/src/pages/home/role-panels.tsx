import { useTranslation } from 'react-i18next'
import {
  APPOINTMENTS,
  APPOINTMENT_COUNTS,
  BEDS,
  DOCTOR_CALENDAR,
  DOCTOR_INQUIRY,
  INQUIRIES,
  LAB_RESULTS,
  NURSE_TASKS,
  OPEN_BILLS,
  OPEN_BILLS_SUMMARY,
  PROVISIONAL_RECEIPTS,
  formatRwf,
  type ApptStatus,
  type Bed,
  type HomeRole,
  type ResultFlag,
  type Tone,
} from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, Row } from '@/components/ui/card'
import { cn } from '@/lib/utils'

const apptTone: Record<ApptStatus, Tone> = { arrived: 'green', due: 'blue', late: 'red' }
const flagTone: Record<ResultFlag, Tone> = { critical: 'red', abnormal: 'yellow', normal: 'green' }
const bedClass: Record<Bed['state'], string> = {
  occupied: 'bg-hover text-ink',
  free: 'bg-green-bg text-green',
  cleaning: 'bg-yellow-bg text-yellow',
}

/** Zone 2 of the home page: what this role must do next. */
export function RolePanels({ role, empty }: { role: HomeRole; empty: boolean }) {
  switch (role) {
    case 'receptionist':
      return <ReceptionistPanels empty={empty} />
    case 'nurse':
      return <NursePanels />
    case 'doctor':
      return <DoctorPanels />
    case 'cashier':
      return <CashierPanels />
  }
}

/** First card grows and scrolls on PC; everything stacks and scrolls as a page on tablets. */
const grow = 'pc:min-h-0 pc:flex-1 pc:overflow-hidden'
const scroll = 'pc:overflow-auto'

function ReceptionistPanels({ empty }: { empty: boolean }) {
  const { t } = useTranslation()
  const counts = empty ? { arrived: 0, due: 0, late: 0 } : APPOINTMENT_COUNTS
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
        {empty ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-6 text-center">
            <div className="text-base font-semibold">{t('home.quietTitle')}</div>
            <div className="text-ink-2">{t('home.quietBody')}</div>
          </div>
        ) : (
          <div className={scroll}>
            {APPOINTMENTS.map((a) => (
              <Row key={`${a.time}-${a.name}`}>
                <span className="text-ink-2 w-11 tabular-nums">{a.time}</span>
                <span className="min-w-0 flex-1">
                  <span className="font-semibold">{a.name}</span>
                  <span className="text-ink-3 block text-xs">{a.doctor}</span>
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
          <Badge tone="yellow" className="tabular-nums">
            {t('home.pending', { count: INQUIRIES.length })}
          </Badge>
        </CardHeader>
        {INQUIRIES.map((i) => (
          <Row key={i.name} className="flex-wrap">
            <span className="min-w-[140px] flex-1">
              <span className="font-semibold">{i.name}</span>
              <span className="text-ink-3 block text-xs">{i.detail}</span>
            </span>
            <span className="flex gap-2">
              <Button variant="primary" size="sm">
                {t('common.approve')}
              </Button>
              <Button variant="danger" size="sm">
                {t('common.reject')}
              </Button>
            </span>
          </Row>
        ))}
      </Card>
    </>
  )
}

function NursePanels() {
  const { t } = useTranslation()
  const occupied = BEDS.filter((b) => b.state === 'occupied').length
  const free = BEDS.filter((b) => b.state === 'free').length
  return (
    <>
      <Card className={grow}>
        <CardHeader>
          <span>{t('home.tasksDue')}</span>
          <Badge tone="red" className="tabular-nums">
            {t('home.overdue', { count: NURSE_TASKS.filter((x) => x.overdue).length })}
          </Badge>
        </CardHeader>
        <div className={scroll}>
          {NURSE_TASKS.map((task) => (
            <Row key={`${task.time}-${task.task}`}>
              <span
                className={cn(
                  'w-11 font-semibold tabular-nums',
                  task.overdue ? 'text-red' : 'text-ink',
                )}
              >
                {task.time}
              </span>
              <span className="min-w-0 flex-1">
                <span className="font-semibold">{task.task}</span>
                <span className="text-ink-3 block text-xs">{task.patient}</span>
              </span>
              <Button size="sm">{t('common.done')}</Button>
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
          {BEDS.map((b) => (
            <div
              key={b.n}
              className={cn(
                'border-border min-h-[52px] rounded-lg border px-2 py-1.5 text-xs',
                bedClass[b.state],
              )}
            >
              <span className="block font-bold">{t('home.bed', { n: b.n })}</span>
              <span>
                {b.state === 'occupied'
                  ? b.who
                  : t(b.state === 'free' ? 'home.bedFree' : 'home.bedCleaning')}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </>
  )
}

function DoctorPanels() {
  const { t } = useTranslation()
  return (
    <>
      <Card className={grow}>
        <CardHeader>
          <span>{t('home.resultsInbox')}</span>
          <Badge tone="red" className="tabular-nums">
            {t('home.critical', { count: LAB_RESULTS.filter((r) => r.flag === 'critical').length })}
          </Badge>
        </CardHeader>
        <div className={scroll}>
          {LAB_RESULTS.map((r) => (
            <Row key={`${r.test}-${r.name}`}>
              <Badge tone={flagTone[r.flag]} className="w-[88px] justify-start">
                {t(`home.flags.${r.flag}`)}
              </Badge>
              <span className="min-w-0 flex-1">
                <span className="font-semibold">
                  {r.test} · {r.name}
                </span>
                <span className="text-ink-3 block text-xs tabular-nums">{r.detail}</span>
              </span>
              <Button size="sm">{t('common.open')}</Button>
            </Row>
          ))}
        </div>
      </Card>
      <div className="grid flex-none grid-cols-1 gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <span>{t('home.todaysCalendar')}</span>
          </CardHeader>
          {DOCTOR_CALENDAR.map((c) => (
            <Row key={c.time} className="min-h-10 py-1.5">
              <span className="text-ink-2 w-11 tabular-nums">{c.time}</span>
              <span className="font-medium">{c.what}</span>
            </Row>
          ))}
        </Card>
        <Card>
          <CardHeader>
            <span>{t('home.inquiriesToAccept')}</span>
          </CardHeader>
          <Row className="flex-col items-stretch gap-2">
            <span>
              <span className="font-semibold">{DOCTOR_INQUIRY.name}</span>
              <span className="text-ink-3 block text-xs">{DOCTOR_INQUIRY.detail}</span>
            </span>
            <span className="flex gap-2">
              <Button variant="primary" size="sm" className="flex-1">
                {t('common.accept')}
              </Button>
              <Button variant="danger" size="sm" className="flex-1">
                {t('common.decline')}
              </Button>
            </span>
          </Row>
        </Card>
      </div>
    </>
  )
}

function CashierPanels() {
  const { t } = useTranslation()
  return (
    <>
      <Card className={grow}>
        <CardHeader>
          <span>{t('home.openBills')}</span>
          <span className="text-ink-2 tabular-nums">
            {t('home.billsDue', {
              count: OPEN_BILLS_SUMMARY.count,
              amount: formatRwf(OPEN_BILLS_SUMMARY.due),
            })}
          </span>
        </CardHeader>
        <div className={scroll}>
          {OPEN_BILLS.map((b) => (
            <Row key={b.name}>
              <span className="min-w-0 flex-1">
                <span className="font-semibold">{b.name}</span>
                <span className="text-ink-3 block text-xs">
                  {t('home.atStation', { station: b.station })}
                </span>
              </span>
              <span className="w-[104px] text-right font-semibold tabular-nums">
                {formatRwf(b.amount)}
              </span>
              <Button variant="primary" size="sm">
                {t('home.takePayment')}
              </Button>
            </Row>
          ))}
        </div>
      </Card>
      <Card className="flex-none">
        <CardHeader>
          <span>{t('home.provisional')}</span>
          <Badge tone="orange" className="tabular-nums">
            {t('home.offlineCount', { count: PROVISIONAL_RECEIPTS.length })}
          </Badge>
        </CardHeader>
        {PROVISIONAL_RECEIPTS.map((p) => (
          <Row key={p.no} className="min-h-10 py-1.5">
            <span className="text-ink-2 w-[110px] tabular-nums">{p.no}</span>
            <span className="flex-1 font-medium">{p.name}</span>
            <span className="text-ink-2 tabular-nums">{formatRwf(p.amount)}</span>
          </Row>
        ))}
      </Card>
    </>
  )
}
