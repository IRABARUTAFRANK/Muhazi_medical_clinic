import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { VitalsForm } from '@/components/clinical/vitals-form'
import { Badge } from '@/components/ui/badge'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { StaffShell } from '@/components/staff/staff-shell'
import { openItems, useQueueBoard } from '@/lib/api/visits'
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
  const { data: items = [], isLoading } = useQueueBoard('triage', user.role)
  const waiting = openItems(items)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected =
    waiting.find((i) => i.queueId === selectedId) ??
    (encounter ? waiting.find((i) => i.encounterId === encounter) : undefined) ??
    waiting[0] ??
    null
  const [notice, setNotice] = useState<string | null>(null)

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="vitals">
      <main className="pc:px-6 pc:pb-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[260px] flex-1">
            <h1 className="m-0 text-2xl font-bold">{t('triage.title')}</h1>
            <p className="text-ink-2 m-0 mt-1 max-w-[680px]">{t('triage.lead')}</p>
          </div>
          <Badge tone="grey" dot={false}>
            {t('home.waiting', { count: waiting.length })}
          </Badge>
        </div>

        {notice && (
          <p className="bg-green-bg text-green m-0 rounded-lg px-3 py-2 text-[13px] font-semibold">
            {notice}
          </p>
        )}

        <div className="pc:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] grid grid-cols-1 gap-4">
          <Card>
            <CardHeader>
              <span>{t('triage.queueTitle')}</span>
              <span className="text-ink-3 text-xs">{isLoading ? '…' : ''}</span>
            </CardHeader>
            {waiting.length === 0 ? (
              <CardBody>
                <p className="text-ink-3 m-0 text-[13px]">{t('triage.empty')}</p>
              </CardBody>
            ) : (
              waiting.map((q) => (
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
                  {q.priority === 1 && <Badge tone="red">{t('home.triage.red')}</Badge>}
                  <span className="text-ink-2 text-xs tabular-nums">
                    {q.waitMin} {t('common.min')}
                  </span>
                </button>
              ))
            )}
          </Card>

          {selected ? (
            <VitalsForm
              key={selected.queueId}
              user={user}
              encounterId={selected.encounterId}
              title={`${selected.ticket} · ${selected.name}`}
              subtitle={`${selected.ageSex} · ${selected.fileNumber}`}
              mode="triage"
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
