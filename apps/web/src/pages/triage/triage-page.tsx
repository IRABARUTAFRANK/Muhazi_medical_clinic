import { Activity } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDuration } from '@/lib/duration'
import type { StaffUser } from '@mmc/shared'
import { BannerChip, PageBanner } from '@/components/dash/page-banner'
import { VitalsForm } from '@/components/clinical/vitals-form'
import { Badge } from '@/components/ui/badge'
import { Reveal } from '@/components/ui/reveal'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { ListBar, Pager } from '@/components/ui/list-tools'
import { Flash } from '@/components/ui/flash'
import { StaffShell } from '@/components/staff/staff-shell'
import { useVisitVitals } from '@/lib/api/billing'
import { useFilesToComplete } from '@/lib/api/desk-ops'
import { openItems, sortQueue, useQueueBoard, type QueueItem } from '@/lib/api/visits'
import { SERVICE_DESK, type ServiceId } from '@/lib/api/services'
import { matches, usePaged, type SortKey } from '@/lib/paging'
import { navForUser } from '@/lib/nav'
import { cn } from '@/lib/utils'
import { NoDeskPage } from '@/components/clinical/desk-gate'
import { NotAllowedPage } from '@/components/clinical/perm-gate'
import { useCanDesk } from '@/lib/api/desks'
import { useCan } from '@/lib/api/permissions'

/**
 * Triage screen (MoH: vitals before the doctor). Left: everyone waiting at triage, in priority
 * order. Right: the measurements, who took them and when, the triage colour and the next
 * station. The nurse uses it at the device; the receptionist (or anyone with the right) uses
 * it to type in what a nurse wrote on paper.
 */
export function TriagePage({ user, encounter }: { user: StaffUser; encounter?: string }) {
  const { t } = useTranslation()
  // The triage desk: a department of the person gives it (or, where no department does, the
  // role). Vital signs of a patient elsewhere in the clinic are still added on the visit screen.
  const canDesk = useCanDesk(user)
  // first the manager's switch (Settings → Who may do what): without it the desk is no use
  const can = useCan(user)
  if (!can('vitals.write'))
    return (
      <NotAllowedPage
        user={user}
        activeId="vitals"
        feature="vitals.write"
        icon={Activity}
        tint="coral"
        title={t('triage.title')}
      />
    )
  if (!canDesk('triage'))
    return (
      <NoDeskPage
        user={user}
        activeId="vitals"
        desks={['triage']}
        icon={Activity}
        tint="coral"
        title={t('triage.title')}
      />
    )
  return <TriageDesk user={user} encounter={encounter} />
}

function TriageDesk({ user, encounter }: { user: StaffUser; encounter?: string }) {
  const { t } = useTranslation()
  const { data: items = [], isLoading } = useQueueBoard('all', user.role)
  // At triage, or anywhere in the clinic without vitals yet.
  const waiting = openItems(items).filter((q) => q.station === 'triage' || !q.vitalsAt)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // A long triage queue: search, choose the order, ten at a time.
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('urgent')
  // the patients waiting for me (sent to me by name, or to triage where I work) come first
  const mineFirst = (q: QueueItem) => (q.forMe && q.canWork !== false ? 0 : 1)
  const shown = sortQueue(
    waiting.filter((q) => matches(query, q.name, q.ticket, q.fileNumber)),
    sort,
  ).sort((a, b) => mineFirst(a) - mineFirst(b))
  // the chosen patient, else the one opened from a link, else the first row of the list
  const selected =
    waiting.find((i) => i.queueId === selectedId) ??
    (encounter ? waiting.find((i) => i.encounterId === encounter) : undefined) ??
    shown[0] ??
    null
  const paged = usePaged(shown, 10, `${query}|${sort}`)
  // Files the nurse started that reception must complete: send those patients to reception.
  const { data: files = [] } = useFilesToComplete()
  const missing = selected
    ? files.find((f) => f.encounterId === selected.encounterId)?.missing
    : undefined
  // Vitals already measured (at registration, by another nurse, from a paper sheet).
  const { data: existing = [] } = useVisitVitals(selected?.encounterId ?? '')
  // At triage the patient is the nurse's they were sent to (or of the nurses working at triage):
  // another nurse sees the form read only; reception and the doctor may still type a nurse's
  // paper sheet, without sending the patient on.
  const notMine = selected?.station === 'triage' && selected.canWork === false
  const lockedNote =
    notMine && user.role === 'nurse'
      ? selected.assignedName && selected.assignedTo !== user.id
        ? t('triage.lockedFor', { name: selected.assignedName })
        : t('triage.lockedSection')
      : null
  /** "for Chantal" on a patient sent to a named nurse ("for you" when it is me). */
  const forWhom = (q: QueueItem) =>
    q.assignedName
      ? q.assignedTo === user.id
        ? t('triage.forYou')
        : t('triage.forName', { name: q.assignedName })
      : null

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
                    'border-border flex w-full items-start gap-3 border-b px-4 py-3 text-left last:border-b-0',
                    selected?.queueId === q.queueId ? 'bg-primary-tint' : 'hover:bg-surface',
                  )}
                >
                  <span className="text-primary w-16 flex-none font-bold whitespace-nowrap tabular-nums">
                    {q.ticket}
                  </span>
                  <span className="min-w-0 flex-1">
                    {/* The full name always: it has its own line and wraps rather than being
                        cut to a letter; the badges go on the line under it. */}
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 font-semibold wrap-break-word">{q.name}</span>
                      <span className="text-ink-2 flex-none text-xs whitespace-nowrap tabular-nums">
                        {formatDuration(q.waitMin, t)}
                      </span>
                    </span>
                    <span className="text-ink-3 block text-xs tabular-nums">
                      {q.ageSex} · {q.fileNumber}
                    </span>
                    <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {q.priority === 1 && <Badge tone="red">{t('home.triage.red')}</Badge>}
                      {q.vitalsAt ? (
                        <Badge tone="green">{t('triage.takenBadge')}</Badge>
                      ) : (
                        <Badge tone="yellow">{t('vitalsForm.noneShort')}</Badge>
                      )}
                      {forWhom(q) && (
                        <Badge tone={q.assignedTo === user.id ? 'blue' : 'grey'} dot={false}>
                          {forWhom(q)}
                        </Badge>
                      )}
                      {q.station !== 'triage' && (
                        <span className="text-ink-3 text-xs">
                          {t(`register.stations.${q.station}`, { defaultValue: q.station })}
                        </span>
                      )}
                    </span>
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
            // choosing a patient (on a tablet the form is below the list): bring the form into view
            <Reveal key={selected.queueId} block="nearest">
              <VitalsForm
                key={`${selected.queueId}|${existing.length}`}
                user={user}
                encounterId={selected.encounterId}
                title={`${selected.ticket} · ${selected.name}`}
                subtitle={`${selected.ageSex} · ${selected.fileNumber}`}
                mode={selected.station === 'triage' ? 'triage' : 'add'}
                station={selected.station}
                mayRoute={!notMine}
                lockedNote={lockedNote}
                existing={existing}
                // the service chosen at registration (else consultation)
                defaultNext={
                  missing && missing.length > 0
                    ? 'reception'
                    : selected.service && selected.service in SERVICE_DESK
                      ? SERVICE_DESK[selected.service as ServiceId]
                      : 'consultation'
                }
                missing={missing}
                onSaved={(ticket, station) => {
                  setNotice(
                    station
                      ? t('triage.sent', { ticket, station: t(`register.stations.${station}`) })
                      : t('vitalsForm.saved'),
                  )
                  setSelectedId(null)
                }}
              />
            </Reveal>
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
