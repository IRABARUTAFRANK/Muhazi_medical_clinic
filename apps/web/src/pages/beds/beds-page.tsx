import { useState, type CSSProperties } from 'react'
import { BedDouble, FolderOpen, History } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatRwf, type StaffUser } from '@mmc/shared'
import { BannerChip, PageBanner } from '@/components/dash/page-banner'
import { PeriodFilter } from '@/components/dash/period-filter'
import { EmptyNote } from '@/components/clinical/empty-note'
import { StayActions, StayFacts } from '@/components/clinical/bed-stay'
import { OpenFileLink } from '@/components/clinical/file-panel'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Flash } from '@/components/ui/flash'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { useBedStays, usePastStays } from '@/lib/api/beds'
import { useCan } from '@/lib/api/permissions'
import { navForUser } from '@/lib/nav'
import { usePeriod } from '@/lib/period'
import { BedsPanel } from '@/pages/home/desk-panels'

/**
 * 0197 · "Patients in beds": the patients who stay at the clinic, apart from those who come, are
 * treated and go home the same day. Each one with the bed, since when, the days so far and
 * expected, the doctor, why, the bed days on the bill and what is still owed; open the visit,
 * move, extend, end the stay (clinical work; the cashier reads). Then every bed (give a free bed,
 * mark a bed ready) and who stayed in a period.
 */
export function BedsPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const can = useCan(user)
  const { stays, free, beds, isLoading, error } = useBedStays()
  const canAct = can('clinical.write') || user.role === 'manager'
  const [notice, setNotice] = useState<string | null>(null)
  const period = usePeriod('month')
  const { data: past = [] } = usePastStays(period.from, period.to)

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="beds">
      <main className="pc:px-6 pc:pb-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <PageBanner
          icon={BedDouble}
          tint="navy"
          title={t('beds.title')}
          lead={t('beds.lead')}
          meta={
            <>
              <BannerChip icon={BedDouble}>
                {t('beds.inBedsCount', { count: stays.length })}
              </BannerChip>
              <BannerChip>{t('beds.freeCount', { count: free.length })}</BannerChip>
            </>
          }
        />
        {error && (
          <p
            role="alert"
            className="bg-red-bg text-red border-red/30 m-0 rounded-md border px-3 py-2 text-[13px] font-semibold"
          >
            {error.message}
          </p>
        )}
        {notice && (
          <Flash key={notice} onClose={() => setNotice(null)}>
            {notice}
          </Flash>
        )}

        <Card className="anim-enter">
          <CardHeader>
            <span className="inline-flex items-center gap-2">
              <BedDouble size={16} aria-hidden="true" />
              {t('beds.now')}
            </span>
            <span className="text-ink-3 text-xs">{t('beds.nowHint')}</span>
          </CardHeader>
          {!isLoading && stays.length === 0 ? (
            <CardBody>
              <EmptyNote>{t('beds.none')}</EmptyNote>
            </CardBody>
          ) : (
            stays.map((s, k) => (
              <Row
                key={s.bed.id}
                className="flex-col items-stretch gap-2 py-3"
                style={{ '--i': k } as CSSProperties}
              >
                <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-0 flex-1 basis-48">
                    <span className="block font-semibold break-words">{s.patient}</span>
                    {s.bed.fileNumber && (
                      <span className="text-ink-3 block text-xs tabular-nums">
                        {s.bed.fileNumber}
                      </span>
                    )}
                  </span>
                  <span className="flex max-w-full flex-wrap items-center gap-2">
                    <StaffLink
                      to="/app/visit"
                      search={{ encounter: s.encounterId }}
                      className={buttonVariants({ size: 'sm', variant: 'primary' })}
                    >
                      <FolderOpen size={14} aria-hidden="true" />
                      {t('visits.openVisit')}
                    </StaffLink>
                    {s.bed.patientId && (
                      <OpenFileLink
                        patientId={s.bed.patientId}
                        className={buttonVariants({ size: 'sm', variant: 'tint-teal' })}
                        aria-label={t('visit.patientFile')}
                        title={t('visit.patientFile')}
                      >
                        <FolderOpen size={14} aria-hidden="true" />
                      </OpenFileLink>
                    )}
                  </span>
                </span>
                <StayFacts stay={s} showOwed />
                {canAct && <StayActions stay={s} free={free} onDone={setNotice} />}
              </Row>
            ))
          )}
        </Card>

        {beds.length > 0 && (
          <BedsPanel i={1} userRole={user.role} canAct={canAct} onBedsPage className="anim-enter" />
        )}

        <Card className="anim-enter">
          <CardHeader>
            <span className="inline-flex items-center gap-2">
              <History size={16} aria-hidden="true" />
              {t('beds.history.title')}
            </span>
            <span className="text-ink-3 text-xs">{t('beds.history.hint')}</span>
          </CardHeader>
          <CardBody className="gap-3">
            <PeriodFilter period={period} />
            {past.length === 0 ? (
              <EmptyNote>{t('beds.history.none')}</EmptyNote>
            ) : (
              <div className="border-border -mx-4 border-t">
                {past.map((p) => (
                  <Row key={p.encounterId} className="flex-wrap gap-x-3 gap-y-1 py-2">
                    <span className="min-w-0 flex-1 basis-48">
                      <span className="block font-semibold break-words">{p.patient}</span>
                      <span className="text-ink-3 block text-xs break-words">
                        {[
                          p.fileNumber,
                          p.beds,
                          `${formatDate(new Date(p.since))} → ${
                            p.until ? formatDate(new Date(p.until)) : t('beds.history.still')
                          }`,
                          p.givenBy,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    <span className="text-ink-2 text-[13px] break-words tabular-nums">
                      {t('beds.history.days', { count: p.days, amount: formatRwf(p.amount) })}
                    </span>
                  </Row>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      </main>
    </StaffShell>
  )
}
