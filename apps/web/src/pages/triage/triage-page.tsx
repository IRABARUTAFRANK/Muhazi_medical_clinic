import { Activity } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDuration } from '@/lib/duration'
import type { StaffUser } from '@mmc/shared'
import { BannerChip, PageBanner } from '@/components/dash/page-banner'
import { VitalsForm } from '@/components/clinical/vitals-form'
import { Badge } from '@/components/ui/badge'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { ListBar, Pager } from '@/components/ui/list-tools'
import { Flash } from '@/components/ui/flash'
import { StaffShell } from '@/components/staff/staff-shell'
import { useVisitVitals } from '@/lib/api/billing'
import { useFilesToComplete } from '@/lib/api/desk-ops'
import { openItems, sortQueue, useQueueBoard } from '@/lib/api/visits'
import { matches, usePaged, type SortKey } from '@/lib/paging'
import { navForUser } from '@/lib/nav'
import { cn } from '@/lib/utils'

/**
 * Triage screen (MoH: vitals before the doctor). Left: everyone waiting at triage, in priority
 * order. Right: the measurements, who took them and when, the triage colour and the next
 * station. The nurse uses it at the device; the receptionist (or anyone with the right) uses
 * it to type in what a nurse wrote on paper.
 */
export function TriagePage({ user, encounter }: { user: StaffUser; encounter?: string }) {
  const { t } = useTranslation()
  const { data: items = [], isLoading } = useQueueBoard('all', user.role)
  // At triage, or anywhere in the clinic without vitals yet.
  const waiting = openItems(items).filter((q) => q.station === 'triage' || !q.vitalsAt)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected =
    waiting.find((i) => i.queueId === selectedId) ??
    (encounter ? waiting.find((i) => i.encounterId === encounter) : undefined) ??
    waiting[0] ??
    null
  const [notice, setNotice] = useState<string | null>(null)
  // A long triage queue: search, choose the order, ten at a time.
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('urgent')
  const shown = sortQueue(
    waiting.filter((q) => matches(query, q.name, q.ticket, q.fileNumber)),
    sort,
  )
  const paged = usePaged(shown, 10, `${query}|${sort}`)
  // Files the nurse started that reception must complete: send those patients to reception.
  const { data: files = [] } = useFilesToComplete()
  const missing = selected
    ? files.find((f) => f.encounterId === selected.encounterId)?.missing
    : undefined
  // Vitals already measured (at registration, by another nurse, from a paper sheet).
  const { data: existing = [] } = useVisitVitals(selected?.encounterId ?? '')

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="vitals">
      <main className="pc:px-6 pc:pb-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <PageBanner
          icon={Activity}
          tint="coral"
          title={t('triage.title')}
          lead={t('triage.lead')}
          meta={
            <BannerChip icon={Activity}>{t('home.waiting', { count: waiting.length })}</BannerChip>
          }
        />

        {notice && (
          <Flash key={notice} onClose={() => setNotice(null)}>
            {notice}
          </Flash>
        )}

        <div className="pc:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] grid grid-cols-1 gap-4">
          <Card>
            <CardHeader>
              <span>{t('triage.queueTitle')}</span>
              <span className="text-ink-3 text-xs">{isLoading ? '…' : ''}</span>
            </CardHeader>
            {waiting.length > 0 && (
              <CardBody className="border-border flex-none border-b py-2.5">
                <ListBar
                  query={query}
                  onQuery={setQuery}
                  sort={sort}
                  onSort={setSort}
                  sorts={['urgent', 'longest', 'latest', 'name']}
                  placeholderKey="list.searchPatient"
                />
              </CardBody>
            )}
            {waiting.length === 0 ? (
              <CardBody>
                <p className="text-ink-3 m-0 text-[13px]">{t('triage.empty')}</p>
              </CardBody>
            ) : (
              paged.slice.map((q) => (
                <button
                  key={q.queueId}
                  type="button"
                  onClick={() => setSelectedId(q.queueId)}
                  className={cn(
                    'border-border flex w-full items-center gap-3 border-b px-4 py-3 text-left last:border-b-0',
                    selected?.queueId === q.queueId ? 'bg-primary-tint' : 'hover:bg-surface',
                  )}
                >
                  <span className="text-primary w-14 font-bold tabular-nums">{q.ticket}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{q.name}</span>
                    <span className="text-ink-3 text-xs tabular-nums">
                      {q.ageSex} · {q.fileNumber}
                    </span>
                  </span>
                  {q.vitalsAt ? (
                    <Badge tone="green">{t('triage.takenBadge')}</Badge>
                  ) : (
                    <Badge tone="yellow">{t('vitalsForm.noneShort')}</Badge>
                  )}
                  {q.station !== 'triage' && (
                    <span className="text-ink-3 text-xs">
                      {t(`register.stations.${q.station}`, { defaultValue: q.station })}
                    </span>
                  )}
                  {q.priority === 1 && <Badge tone="red">{t('home.triage.red')}</Badge>}
                  <span className="text-ink-2 text-xs tabular-nums">
                    {formatDuration(q.waitMin, t)}
                  </span>
                </button>
              ))
            )}
            {waiting.length > 0 && (
              <CardBody className="flex-none py-2">
                <Pager {...paged} onPage={paged.setPage} />
              </CardBody>
            )}
          </Card>

          {selected ? (
            <VitalsForm
              key={`${selected.queueId}|${existing.length}`}
              user={user}
              encounterId={selected.encounterId}
              title={`${selected.ticket} · ${selected.name}`}
              subtitle={`${selected.ageSex} · ${selected.fileNumber}`}
              mode={selected.station === 'triage' ? 'triage' : 'add'}
              existing={existing}
              defaultNext={missing && missing.length > 0 ? 'reception' : 'consultation'}
              missing={missing}
              onSaved={(ticket, station) => {
                setNotice(
                  t('triage.sent', {
                    ticket,
                    station: station ? t(`register.stations.${station}`) : '',
                  }),
                )
                setSelectedId(null)
              }}
            />
          ) : (
            <Card>
              <CardBody>
                <p className="text-ink-3 m-0 text-[13px]">{t('triage.select')}</p>
              </CardBody>
            </Card>
          )}
        </div>
      </main>
    </StaffShell>
  )
}
