import { FolderLock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { PageBanner } from '@/components/dash/page-banner'
import { Card, CardBody } from '@/components/ui/card'
import { StaffShell } from '@/components/staff/staff-shell'
import { navForUser } from '@/lib/nav'
import { StaffDocumentsPanel } from './staff-documents'

/**
 * "My documents" (0116): the licence, the contract and the other papers the clinic keeps for the
 * signed-in employee, read only. Opened from the user menu (PC) or the "More" sheet (tablet).
 * The manager adds and removes documents from the Employees page.
 */
export function MyDocumentsPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  return (
    <StaffShell user={user} nav={navForUser(user)}>
      <main className="pc:p-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <PageBanner icon={FolderLock} tint="navy" title={t('staffDocs.myTitle')} />
        <Card className="max-w-[1100px]">
          <CardBody>
            <StaffDocumentsPanel profileId={user.id} name={user.name} readOnly />
          </CardBody>
        </Card>
      </main>
    </StaffShell>
  )
}
