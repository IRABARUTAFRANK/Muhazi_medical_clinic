import { useState } from 'react'
import { HeartHandshake, UserRoundCheck, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime, type StaffUser } from '@mmc/shared'
import { Hint, Panel } from '@/components/dash/kit'
import { Button } from '@/components/ui/button'
import { useCoverActions, useMyCover, type CoverCovering } from '@/lib/api/cover'
import { useColleagues } from '@/lib/api/referrals'
import { openItems, stationFor, useQueueBoard } from '@/lib/api/visits'
import { MyQueuePanel } from './role-panels'

const control =
  'border-border bg-card text-ink focus:border-primary h-10 w-full rounded-lg border px-2.5 text-[14px] outline-none'
const at = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`
// datetime-local value for "today at 17:00", or in 4 hours when it is already later.
const defaultUntil = () => {
  const d = new Date()
  const five = new Date(d)
  five.setHours(17, 0, 0, 0)
  const end =
    five.getTime() - d.getTime() > 30 * 60_000 ? five : new Date(d.getTime() + 4 * 3_600_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}T${pad(end.getHours())}:${pad(end.getMinutes())}`
}

/**
 * Doctor: "Cover for me". A nurse takes over the doctor's patients for a period (absence,
 * theatre, training); she gets the doctor's rights during it and the doctor can end it any time.
 */
export function CoverMePanel() {
  const { t } = useTranslation()
  const { data } = useMyCover()
  const { data: colleagues = [] } = useColleagues()
  const actions = useCoverActions()
  const nurses = colleagues.filter((c) => c.role === 'nurse')
  const [open, setOpen] = useState(false)
  const [nurseId, setNurseId] = useState('')
  const [until, setUntil] = useState(defaultUntil)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const active = data?.coveredBy[0]

  const start = async () => {
    setError(null)
    const nurse = nurses.find((n) => n.id === nurseId)
    if (!nurse) return setError(t('cover.pickNurse'))
    try {
      await actions.start.mutateAsync({
        nurseId,
        nurse: nurse.name,
        until: new Date(until).toISOString(),
        note,
      })
      setOpen(false)
      setNote('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Panel i={1} icon={HeartHandshake} tint="mint" title={t('cover.title')}>
      {active ? (
        <div className="bg-green-bg/60 flex flex-wrap items-center gap-3 rounded-xl px-3 py-2.5">
          <UserRoundCheck size={18} aria-hidden="true" className="text-green" />
          <span className="min-w-0 flex-1 text-[14px]">
            <b>{t('cover.coveredBy', { name: active.nurse, until: at(active.until) })}</b>
            {active.note && <span className="text-ink-2 block text-[13px]">{active.note}</span>}
          </span>
          <Button size="sm" variant="ghost" onClick={() => void actions.end.mutateAsync(active.id)}>
            <X size={14} aria-hidden="true" />
            {t('cover.end')}
          </Button>
        </div>
      ) : open ? (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
              {t('cover.nurse')}
              <select
                className={control}
                value={nurseId}
                onChange={(e) => setNurseId(e.target.value)}
              >
                <option value="">{t('cover.pickNurse')}</option>
                {nurses.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                    {n.station ? ` · ${n.station}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
              {t('cover.until')}
              <input
                type="datetime-local"
                className={control}
                value={until}
                onChange={(e) => setUntil(e.target.value)}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
            {t('cover.note')}
            <input className={control} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          {error && (
            <p className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold">
              {error}
            </p>
          )}
          <span className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              loading={actions.start.isPending}
              onClick={() => void start()}
            >
              <HeartHandshake size={16} aria-hidden="true" />
              {t('cover.start')}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('staff.form.cancel')}
            </Button>
          </span>
        </div>
      ) : (
        <Button className="self-start" onClick={() => setOpen(true)}>
          <HeartHandshake size={16} aria-hidden="true" />
          {t('cover.ask')}
        </Button>
      )}
      <Hint>{t('cover.hint')}</Hint>
    </Panel>
  )
}

/** Nurse: "You are covering for Dr X" with the doctor's queue (take, treat, finish). */
export function CoveringPanels({ user }: { user: StaffUser }) {
  const { data } = useMyCover()
  const covering = data?.covering ?? []
  if (covering.length === 0) return null
  return (
    <>
      {covering.map((c) => (
        <CoveringPanel key={c.id} cover={c} user={user} />
      ))}
    </>
  )
}

function CoveringPanel({ cover, user }: { cover: CoverCovering; user: StaffUser }) {
  const { t } = useTranslation()
  const actions = useCoverActions()
  // The doctor's desk ("Consultation 1" → consultation).
  const station = stationFor({ ...user, role: 'doctor', station: cover.station ?? undefined })
  const { data: queue = [] } = useQueueBoard(station, 'doctor')
  const rows = openItems(queue)
  return (
    <div className="flex flex-col gap-3">
      <div className="border-green/30 bg-green-bg flex flex-wrap items-center gap-3 rounded-[16px] border px-4 py-3">
        <UserRoundCheck size={20} aria-hidden="true" className="text-green" />
        <span className="min-w-0 flex-1 text-[15px]">
          <b>{t('cover.covering', { name: cover.doctor, until: at(cover.until) })}</b>
          {cover.note && <span className="text-ink-2 block text-[13px]">{cover.note}</span>}
          <span className="text-ink-2 block text-[13px]">{t('cover.coveringHint')}</span>
        </span>
        <Button size="sm" variant="ghost" onClick={() => void actions.end.mutateAsync(cover.id)}>
          <X size={14} aria-hidden="true" />
          {t('cover.end')}
        </Button>
      </div>
      <MyQueuePanel
        title={t('cover.queue', { name: cover.doctor })}
        rows={rows}
        counts={{
          waiting: rows.filter((r) => !r.startedAt).length,
          inProgress: rows.filter((r) => r.startedAt).length,
          done: 0,
        }}
        rowAction="call"
      />
    </div>
  )
}
