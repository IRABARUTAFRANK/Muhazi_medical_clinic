import {
  ArrowRight,
  Banknote,
  FlaskConical,
  HeartPulse,
  Layers,
  Receipt,
  UserPlus,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { NoDeskNotice } from '@/components/clinical/desk-gate'
import { Empty, Panel, SectionTitle } from '@/components/dash/kit'
import { actionLink, buttonVariants } from '@/components/ui/button'
import { ShownList } from '@/components/ui/list-tools'
import { StaffLink } from '@/components/staff/staff-link'
import { useHomeSummary } from '@/lib/api/home'
import { useLabWorklist } from '@/lib/api/lab'
import { useCan } from '@/lib/api/permissions'
import { onePerPool, openItems, useQueueBoard } from '@/lib/api/visits'
import { useNow } from '@/lib/hooks'
import { cn } from '@/lib/utils'
import { PharmacyDesk } from '../stock/pharmacy-desk'
import { LabOrderRow } from '../lab/lab-parts'
import { AppointmentsPanel, BedsPanel, TasksPanel } from './desk-panels'
import { MyQueuePanel } from './role-panels'
import { OpenBillsPanel } from './bills-panel'
import {
  homeKindFor,
  KIND_NATIVE,
  NOTICE_DESKS,
  ROLE_KIND,
  useHomeDesks,
  type HomeKind,
} from './home-desks-rules'

/**
 * Under a dashboard: "ask the manager" when the person works at none of their role's desks, then
 * the blocks of the desks their departments give that this dashboard does not show (a doctor in
 * the Laboratory: the lab worklist; a nurse in the Pharmacy: the hand-over desk).
 */
export function DeskBlocks({ user, kind }: { user: StaffUser; kind: HomeKind }) {
  const { t } = useTranslation()
  const { desks, extra } = useHomeDesks(user)
  const can = useCan(user)
  if (kind === 'cashier' || user.role === 'manager' || user.role === 'cashier') return null
  const { noDesk } = homeKindFor(user.role, desks)
  const native = KIND_NATIVE[kind]
  const more = extra.filter((d) => !native.includes(d))
  const lab = more.some((d) => d === 'laboratory' || d === 'ultrasound')
  // "Take payments" given to someone whose role does not take money: the bills to settle
  const money = can('payment.take')
  if (!noDesk && more.length === 0 && !money) return null
  const ownNotice =
    user.dbRole === 'sonographer' ? (['ultrasound'] as const) : NOTICE_DESKS[ROLE_KIND[user.role]]
  return (
    <section className="flex flex-col gap-3">
      {noDesk && <NoDeskNotice desks={ownNotice} />}
      {money && <MoneyBlock />}
      {more.length > 0 && (
        <>
          <SectionTitle icon={Layers}>{t('homeDesks.section')}</SectionTitle>
          <div className="pc:grid-cols-2 grid grid-cols-1 gap-4">
            {more.includes('reception') && (
              <AppointmentsPanel
                canAct={can('appointment.approve')}
                canArrive={can('visit.start')}
                limit={6}
                footer={
                  can('visit.start') ? (
                    <StaffLink
                      to="/app/register"
                      className={cn(buttonVariants({ size: 'sm' }), 'self-start')}
                    >
                      <UserPlus size={15} aria-hidden="true" />
                      {t('dashboard.registerPatient')}
                    </StaffLink>
                  ) : undefined
                }
              />
            )}
            {more.includes('triage') && can('vitals.write') && <TriageBlock user={user} />}
            {more.includes('nursing') && (
              <>
                <BedsPanel userRole={user.role} canAct={can('clinical.write')} />
                <TasksPanel canAct={can('clinical.write')} />
              </>
            )}
            {lab && <LabBenchPanel />}
            {more.includes('pharmacy') && (
              <div className="pc:col-span-2 flex min-w-0 flex-col gap-4">
                <PharmacyDesk canDispense />
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}

/** The bills to settle and the way to the payments of the day (her own cash count), for someone
 *  whose role does not take money but whom the manager allows to (Take payments). */
function MoneyBlock() {
  const { t } = useTranslation()
  const { data } = useHomeSummary()
  return (
    <>
      <SectionTitle icon={Receipt}>{t('homeDesks.money')}</SectionTitle>
      <OpenBillsPanel
        bills={data?.openBills ?? []}
        canTake
        footer={
          <>
            <StaffLink to="/app/bills" className={buttonVariants({ size: 'sm' })}>
              <Receipt size={15} aria-hidden="true" />
              {t('nav.bills')}
            </StaffLink>
            <StaffLink to="/app/payments" className={buttonVariants({ size: 'sm' })}>
              <Banknote size={15} aria-hidden="true" />
              {t('finance.dayClose')}
            </StaffLink>
          </>
        }
      />
    </>
  )
}

/** The patients waiting at triage, for someone whose department does triage too. */
function TriageBlock({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const { data: queue = [] } = useQueueBoard('triage', user.role)
  const rows = onePerPool(openItems(queue))
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <MyQueuePanel
        title={t('desk.nurse.queue')}
        rows={rows}
        counts={{
          waiting: rows.filter((r) => !r.startedAt).length,
          inProgress: rows.filter((r) => r.startedAt).length,
          done: 0,
        }}
        rowAction="open"
      />
      <StaffLink
        to="/app/vitals"
        className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'self-start')}
      >
        <HeartPulse size={15} aria-hidden="true" />
        {t('desk.nurse.takeVitals')}
      </StaffLink>
    </div>
  )
}

/** The tests waiting at the person's laboratory or ultrasound desk (only theirs: lab_worklist
 *  holds the tests of the desks they have), each row taking the test to its next step. */
export function LabBenchPanel() {
  const { t } = useTranslation()
  const now = useNow()
  const { data: open = [] } = useLabWorklist('open')
  return (
    <Panel
      i={2}
      icon={FlaskConical}
      tint="violet"
      title={t('lab.worklistTitle')}
      right={t('lab.openCount', { count: open.length })}
    >
      {open.length === 0 ? (
        <Empty>{t('homeDesks.labEmpty')}</Empty>
      ) : (
        <ShownList items={open} step={5}>
          {(shown) => (
            <div className="flex flex-col">
              {shown.map((o, i) => (
                <LabOrderRow key={o.id} order={o} i={i} now={now} />
              ))}
            </div>
          )}
        </ShownList>
      )}
      <StaffLink to="/app/lab" className={cn(actionLink, 'self-start text-[13px]')}>
        {t('lab.openWorklist')}
        <ArrowRight size={14} aria-hidden="true" />
      </StaffLink>
    </Panel>
  )
}
