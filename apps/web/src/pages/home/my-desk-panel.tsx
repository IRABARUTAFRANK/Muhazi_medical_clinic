import { UserRoundCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { Hint, SectionTitle } from '@/components/dash/kit'
import { stationLabel } from '@/components/dash/kit-style'
import { useMySummary } from '@/lib/api/my'
import { WaitingForMePanel } from './my-panels'

/**
 * "My desk" at the top of the manager dashboard (0120): when the manager also works at a desk
 * (the profile names one: "Triage", "Consultation 2"…) or a patient was sent to them by name,
 * their own waiting patients, apart from the clinic's totals under it. Nothing shows for a
 * manager who only manages.
 */
export function MyDeskPanel({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const { data: my } = useMySummary(null)
  if (!my || my.needsUpdate) return null
  const station = my.station ?? (user.station ? user.station : null)
  if (!station && my.waiting.length === 0) return null
  const where = my.station ? stationLabel(my.station, t) : (user.station ?? '')
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle icon={UserRoundCheck}>
        {where ? t('my.desk.titleAt', { desk: where }) : t('my.desk.title')}
      </SectionTitle>
      <WaitingForMePanel
        summary={my}
        rowAction="call"
        title={t('my.waitingForMe')}
        done={my.work.patientsSeen ?? 0}
      />
      <Hint>{t('my.desk.hint')}</Hint>
    </section>
  )
}
