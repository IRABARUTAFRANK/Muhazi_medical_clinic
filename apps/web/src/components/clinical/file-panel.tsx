import type { ReactNode } from 'react'
import { FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Chip } from '@/components/ui/chip'
import { SidePanel } from '@/components/ui/side-panel'
import { ageSexOf, usePatientFile } from '@/lib/api/patients'
import {
  actionLinkClass,
  plainClick,
  useCloseFile,
  useFileHref,
  useOpenFile,
  useOpenFileId,
  useOpenFileTab,
} from '@/lib/panel-url'
import { cn } from '@/lib/utils'
import { PatientFilePage } from '@/pages/patients/patient-file-page'
import { useSession } from '@/store/session'

/*
 * The patient file beside the list it was opened from. `useOpenFile()` (lib/panel-url.ts) puts
 * `?file=<patientId>` on the address; `FilePanelHost`, mounted once per page (or in the staff
 * shell), shows the file in a side panel while it is there; `OpenFileLink` is the teal action
 * link of the lists, with a real href underneath so a middle / ctrl-click still opens the whole
 * page.
 */

export interface OpenFileLinkProps {
  patientId: string
  tab?: string
  /** `buttonVariants(...)` to look like a button; the teal action link otherwise. */
  className?: string
  title?: string
  'aria-label'?: string
  /** Without children: the folder icon and "Open file". */
  children?: ReactNode
}

export function OpenFileLink({ patientId, tab, className, children, ...rest }: OpenFileLinkProps) {
  const { t } = useTranslation()
  const openFile = useOpenFile()
  const href = useFileHref()(patientId, tab)
  return (
    <a
      href={href}
      className={cn(className ?? actionLinkClass)}
      onClick={(e) => {
        if (!plainClick(e)) return
        e.preventDefault()
        openFile(patientId, tab)
      }}
      {...rest}
    >
      {children ?? (
        <>
          <FolderOpen size={14} aria-hidden="true" />
          {t('patients.openFile')}
        </>
      )}
    </a>
  )
}

/**
 * Mount once on a page (or in the staff shell): shows the patient file in a side panel while
 * `?file=` is in the address. The header carries the name, the file number, age and sex, the
 * triage colour of an open visit, and "Open full page".
 */
export function FilePanelHost() {
  const user = useSession((s) => s.user)
  const file = useOpenFileId()
  const tab = useOpenFileTab()
  const close = useCloseFile()
  if (!user || !file) return null
  return <FilePanel key={file} patientId={file} tab={tab} onClose={close} />
}

function FilePanel({
  patientId,
  tab,
  onClose,
}: {
  patientId: string
  tab?: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const user = useSession((s) => s.user)
  // the same query as the file itself: one fetch, shared
  const { data } = usePatientFile(patientId)
  const p = data?.patient
  const openVisit = data?.visits.find((v) => v.status === 'open')
  if (!user) return null
  return (
    <SidePanel
      open
      onClose={onClose}
      hue="teal"
      icon={FolderOpen}
      title={p ? `${p.surname} ${p.given_names}` : t('patients.openFile')}
      subtitle={p ? `${p.file_number} · ${ageSexOf(p.birth_date, p.sex)}` : '…'}
      tags={
        <>
          {openVisit?.triage && (
            <Badge tone={openVisit.triage}>{t(`home.triage.${openVisit.triage}`)}</Badge>
          )}
          {openVisit && <Chip>{t('patients.inClinic')}</Chip>}
        </>
      }
      fullPageTo={{ to: '/app/patient', search: { id: patientId, tab } }}
      padded={false}
    >
      <div className="p-4">
        <PatientFilePage embedded user={user} patientId={patientId} initialTab={tab} />
      </div>
    </SidePanel>
  )
}
