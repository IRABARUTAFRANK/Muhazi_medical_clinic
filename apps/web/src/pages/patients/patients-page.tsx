import { useState, type CSSProperties } from 'react'
import { ChevronLeft, ChevronRight, FolderOpen, Search, UserPlus, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatRwf, type StaffUser } from '@mmc/shared'
import { BannerChip, PageBanner } from '@/components/dash/page-banner'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Chip } from '@/components/ui/chip'
import { Field } from '@/components/ui/field'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { PATIENTS_PAGE_SIZE, ageSexOf, usePatientsList } from '@/lib/api/patients'
import { navForUser } from '@/lib/nav'
import { openItems, stationFor, useQueueBoard } from '@/lib/api/visits'
import { MyQueuePanel } from '@/pages/home/role-panels'
import { cn } from '@/lib/utils'

/**
 * The patient register: every patient the clinic has registered, newest activity first,
 * searchable by name, file number, phone or national ID. Each row opens the patient file.
 */
export function PatientsPage({ user, initialQuery }: { user: StaffUser; initialQuery: string }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState(initialQuery)
  const [page, setPage] = useState(0)
  const { data, isFetching, error } = usePatientsList(query, page)
  const total = data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PATIENTS_PAGE_SIZE))
  // Patients sent to my desk: what needs my attention first.
  const { data: queue = [] } = useQueueBoard(stationFor(user), user.role)
  const mine = openItems(queue)

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="patients">
      <main className="pc:px-6 pc:pb-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <PageBanner
          icon={Users}
          tint="teal"
          title={t('patients.title')}
          lead={t('patients.lead')}
          user={user}
          meta={<BannerChip icon={Users}>{t('patients.count', { count: total })}</BannerChip>}
        >
          <StaffLink to="/app/register" className={buttonVariants({ variant: 'primary' })}>
            <UserPlus size={18} aria-hidden="true" />
            {t('register.title')}
          </StaffLink>
        </PageBanner>

        {!['manager', 'receptionist'].includes(user.role) && (
          <MyQueuePanel
            title={t('patients.forMe', { station: t(`register.stations.${stationFor(user)}`) })}
            rows={mine}
            counts={{
              waiting: mine.filter((r) => !r.startedAt).length,
              inProgress: mine.filter((r) => r.startedAt).length,
              done: 0,
            }}
            rowAction="open"
          />
        )}

        <Card className="anim-enter" style={{ '--i': 1 } as CSSProperties}>
          <CardBody>
            <Field
              label={t('patients.search')}
              placeholder={t('register.searchPh')}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setPage(0)
              }}
              autoComplete="off"
              autoFocus
            />
          </CardBody>
        </Card>

        {error && (
          <p
            role="alert"
            className="bg-red-bg text-red m-0 rounded-xl px-3 py-2 text-[13px] font-semibold"
          >
            {error.message}
          </p>
        )}

        <Card className="anim-enter" style={{ '--i': 2 } as CSSProperties}>
          <CardHeader>
            <span className="inline-flex items-center gap-2">
              <Search size={16} aria-hidden="true" />
              {query.trim() ? t('patients.results', { query }) : t('patients.recent')}
            </span>
            <span className="text-ink-3 text-xs">{isFetching ? '…' : ''}</span>
          </CardHeader>
          {data && data.rows.length === 0 && (
            <CardBody>
              <p className="text-ink-3 m-0 text-[13px]">{t('patients.none')}</p>
            </CardBody>
          )}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="text-ink-3 text-left text-[11px] tracking-[.04em] uppercase">
                  <th className="border-border hidden border-b px-4 py-2 font-semibold sm:table-cell">
                    {t('patients.cols.file')}
                  </th>
                  <th className="border-border border-b px-2 py-2 font-semibold">
                    {t('patients.cols.patient')}
                  </th>
                  <th className="border-border hidden border-b px-2 py-2 font-semibold sm:table-cell">
                    {t('patients.cols.ageSex')}
                  </th>
                  <th className="border-border hidden border-b px-2 py-2 font-semibold lg:table-cell">
                    {t('patients.cols.phone')}
                  </th>
                  <th className="border-border hidden border-b px-2 py-2 font-semibold lg:table-cell">
                    {t('patients.cols.lastVisit')}
                  </th>
                  <th className="border-border hidden border-b px-2 py-2 text-right font-semibold lg:table-cell">
                    {t('patients.cols.visits')}
                  </th>
                  <th className="border-border hidden border-b px-2 py-2 font-semibold sm:table-cell">
                    {t('patients.cols.status')}
                  </th>
                  <th className="border-border border-b px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {data?.rows.map((r, i) => (
                  <tr
                    key={r.id}
                    className="border-grid anim-enter hover:bg-hover/60 border-b transition-colors last:border-b-0"
                    style={{ '--i': i } as CSSProperties}
                  >
                    <td className="text-primary hidden px-4 py-2.5 font-bold tabular-nums sm:table-cell">
                      {r.fileNumber}
                    </td>
                    <td className="px-3 py-2.5 sm:px-2">
                      <span className="block font-semibold">
                        {r.surname} {r.givenNames}
                      </span>
                      <span className="text-ink-3 block text-xs">
                        <span className="sm:hidden">
                          <span className="text-primary font-bold tabular-nums">
                            {r.fileNumber}
                          </span>
                          {' · '}
                          {ageSexOf(r.birthDate, r.sex)} ·{' '}
                        </span>
                        {[
                          r.sector,
                          t('patients.registered', { date: formatDate(new Date(r.registeredAt)) }),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      {(r.openEncounterId ||
                        r.balanceDue > 0 ||
                        r.hasAllergies ||
                        !!r.flags.vip) && (
                        <span className="mt-1 flex flex-wrap gap-1.5 sm:hidden">
                          {r.openEncounterId && <Badge tone="blue">{t('patients.inClinic')}</Badge>}
                          {r.balanceDue > 0 && (
                            <Badge tone="orange">
                              {t('patients.owes', { amount: formatRwf(r.balanceDue) })}
                            </Badge>
                          )}
                          {r.hasAllergies && <Badge tone="red">{t('patients.allergies')}</Badge>}
                          {!!r.flags.vip && <Chip>VIP</Chip>}
                        </span>
                      )}
                    </td>
                    <td className="hidden px-2 py-2.5 tabular-nums sm:table-cell">
                      {ageSexOf(r.birthDate, r.sex)}
                    </td>
                    <td className="hidden px-2 py-2.5 tabular-nums lg:table-cell">
                      {r.phone ?? '—'}
                    </td>
                    <td className="hidden px-2 py-2.5 tabular-nums lg:table-cell">
                      {r.lastVisitAt ? formatDate(new Date(r.lastVisitAt)) : '—'}
                    </td>
                    <td className="hidden px-2 py-2.5 text-right tabular-nums lg:table-cell">
                      {r.visits}
                    </td>
                    <td className="hidden px-2 py-2.5 sm:table-cell">
                      <span className="flex flex-wrap gap-1.5">
                        {r.openEncounterId && <Badge tone="blue">{t('patients.inClinic')}</Badge>}
                        {r.balanceDue > 0 && (
                          <Badge tone="orange">
                            {t('patients.owes', { amount: formatRwf(r.balanceDue) })}
                          </Badge>
                        )}
                        {r.hasAllergies && <Badge tone="red">{t('patients.allergies')}</Badge>}
                        {!!r.flags.vip && <Chip>VIP</Chip>}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right sm:px-4">
                      <StaffLink
                        to="/app/patient"
                        search={{ id: r.id }}
                        aria-label={t('patients.openFile')}
                        title={t('patients.openFile')}
                        className={cn(
                          buttonVariants({ size: 'sm', variant: 'primary' }),
                          'whitespace-nowrap',
                        )}
                      >
                        <FolderOpen size={14} aria-hidden="true" />
                        <span className="hidden sm:inline">{t('patients.openFile')}</span>
                      </StaffLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <CardBody className="border-border flex-row items-center justify-end gap-2 border-t">
              <span className="text-ink-3 text-xs tabular-nums">
                {t('patients.page', { page: page + 1, pages })}
              </span>
              <Button
                size="sm"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
                aria-label={t('patients.prev')}
              >
                <ChevronLeft size={16} aria-hidden="true" />
              </Button>
              <Button
                size="sm"
                disabled={page + 1 >= pages}
                onClick={() => setPage((p) => p + 1)}
                aria-label={t('patients.next')}
              >
                <ChevronRight size={16} aria-hidden="true" />
              </Button>
            </CardBody>
          )}
        </Card>
      </main>
    </StaffShell>
  )
}
