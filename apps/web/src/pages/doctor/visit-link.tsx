import { FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { buttonVariants } from '@/components/ui/button'
import { OpenFileLink } from '@/components/clinical/file-panel'
import { StaffLink } from '@/components/staff/staff-link'

/** Open the visit while it is open, the patient file afterwards. */
export function VisitLink({
  open,
  encounterId,
  patientId,
}: {
  open: boolean
  encounterId: string
  patientId: string
}) {
  const { t } = useTranslation()
  return open ? (
    <StaffLink
      to="/app/visit"
      search={{ encounter: encounterId }}
      className={buttonVariants({ size: 'sm', variant: 'tint-blue' })}
    >
      <FolderOpen size={14} aria-hidden="true" />
      {t('visits.openVisit')}
    </StaffLink>
  ) : (
    // the file opens in the side panel; the link underneath keeps middle-click and ctrl-click
    // on the whole page
    <OpenFileLink
      patientId={patientId}
      className={buttonVariants({ size: 'sm', variant: 'tint-blue' })}
    >
      <FolderOpen size={14} aria-hidden="true" />
      {t('visit.patientFile')}
    </OpenFileLink>
  )
}
