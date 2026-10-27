import { CalendarCheck, CircleAlert, FolderOpen, Stethoscope } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { SidePanel } from '@/components/ui/side-panel'
import { StaffLink } from '@/components/staff/staff-link'
import { useAppointmentDetail } from '@/lib/api/desk-ops'

const when = (iso: string | null) =>
  iso ? `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}` : '—'

const TONE: Record<string, 'blue' | 'green' | 'yellow' | 'red' | 'grey'> = {
  inquiry: 'yellow',
  approved: 'yellow',
  confirmed: 'blue',
  arrived: 'green',
  in_progress: 'green',
  completed: 'green',
  no_show: 'red',
  cancelled: 'red',
  rejected: 'red',
  declined: 'red',
}

/**
 * Everything about one booking, in a side panel (rose: bookings) over the day's list, which
 * keeps the chosen row tinted. Closing it (Escape, the overlay, ×) returns to the list.
 */
export function AppointmentDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useTranslation()
  const { data: a, isLoading, error } = useAppointmentDetail(id)
  const rows: [string, string | null | undefined][] = a
    ? [
        [t('ops.detail.when'), when(a.startsAt)],
        [t('ops.detail.doctor'), a.doctor],
        [t('ops.detail.reason'), a.reason],
        [t('ops.detail.service'), a.category],
        [
          t('ops.detail.patient'),
          a.patientName ? `${a.patientFile ?? ''} · ${a.patientName}` : a.contactName,
        ],
        [t('ops.detail.phone'), a.patientPhone ?? a.contactPhone],
        [
          t('ops.detail.channel'),
          a.channel ? t(`ops.detail.channels.${a.channel}`, { defaultValue: a.channel }) : null,
        ],
        [
          t('ops.detail.source'),
          a.source ? t(`ops.detail.sources.${a.source}`, { defaultValue: a.source }) : null,
        ],
        [t('ops.detail.reference'), a.reference],
        [t('ops.detail.requestedAt'), when(a.createdAt)],
        [t('ops.detail.preferred'), a.preferredAt ? when(a.preferredAt) : null],
        [t('ops.detail.approved'), a.approvedBy ? `${a.approvedBy} · ${when(a.approvedAt)}` : null],
        [t('ops.detail.accepted'), a.acceptedBy ? `${a.acceptedBy} · ${when(a.acceptedAt)}` : null],
        [t('ops.detail.cancelReason'), a.cancelReason],
        [t('ops.detail.insurer'), a.insurer],
      ]
    : []

  return (
    <SidePanel
      open={id !== null}
      onClose={onClose}
      hue="rose"
      icon={CalendarCheck}
      title={a ? (a.patientName ?? a.contactName ?? '') : t('ops.detail.title')}
      subtitle={a ? [when(a.startsAt), a.doctor].filter(Boolean).join(' · ') : undefined}
      tags={
        a ? (
          <Badge tone={TONE[a.status] ?? 'grey'}>
            {t(`ops.appts.status.${a.status}`, { defaultValue: a.status })}
          </Badge>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        {error && (
          <p className="border-red/30 bg-red-bg text-red m-0 flex items-start gap-2 rounded-md border px-3 py-2 text-[13px] font-medium">
            <CircleAlert size={16} aria-hidden="true" className="mt-0.5 flex-none" />
            <span>{error.message}</span>
          </p>
        )}
        {isLoading && <p className="text-ink-3 m-0 text-[13px]">…</p>}
        {a && (
          <>
            <dl className="border-border m-0 grid grid-cols-1 gap-x-4 gap-y-2 rounded-md border p-4 sm:grid-cols-[160px_minmax(0,1fr)]">
              {rows
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-ink-3 text-[13px]">{k}</dt>
                    <dd className="text-ink m-0 text-[14px] font-medium">{v}</dd>
                  </div>
                ))}
            </dl>
            <div className="flex flex-wrap gap-2">
              {a.patientId && (
                <StaffLink
                  to="/app/patient"
                  search={{ id: a.patientId }}
                  className={buttonVariants({ size: 'sm' })}
                >
                  <FolderOpen size={14} aria-hidden="true" />
                  {t('patients.openFile')}
                </StaffLink>
              )}
              {a.encounterId && (
                <StaffLink
                  to="/app/visit"
                  search={{ encounter: a.encounterId }}
                  className={buttonVariants({ size: 'sm', variant: 'primary' })}
                >
                  <Stethoscope size={14} aria-hidden="true" />
                  {t('register.done.openVisit')}
                </StaffLink>
              )}
            </div>
          </>
        )}
      </div>
    </SidePanel>
  )
}
