import { useState } from 'react'
import { BookOpenCheck, Library, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { PageBanner } from '@/components/dash/page-banner'
import { Card, CardBody } from '@/components/ui/card'
import { Flash } from '@/components/ui/flash'
import { Seg } from '@/components/ui/seg'
import { StaffShell } from '@/components/staff/staff-shell'
import { useInsurers } from '@/lib/api/catalogue'
import { useInsuranceEnabled } from '@/lib/api/settings'
import { navForUser } from '@/lib/nav'
import { InsurersSection } from './insurers-section'
import { OfficialListSection } from './official-list-section'
import { PriceListsSection } from './price-lists-section'

type Part = 'lists' | 'insurers' | 'official'

/**
 * Management › Price lists & insurers: everything about the prices others publish and the
 * insurers the clinic works with, on its own page (it used to sit under the treatments on Prices,
 * where it mixed with them): the published lists (the Ministry's tariff, RSSB's and each insurer's
 * lists of treatments and of medicines — upload any kind of file, choose its sheets and columns,
 * who pays which column), the insurers (coverage, rules, their own prices, their exceptions), and
 * the official medicine list (RHIA). One part at a time.
 */
export function PriceListsPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const { data: insurers = [], error: insurersError } = useInsurers()
  const insurance = useInsuranceEnabled()
  const [part, setPart] = useState<Part>('lists')
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const say = (text: string) => {
    setActionError(null)
    setNotice(text)
  }

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="price-lists">
      <main className="pc:px-6 pc:pb-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <PageBanner
          icon={Library}
          tint="violet"
          title={t('priceListsPage.title')}
          lead={t('priceListsPage.lead')}
        />
        <Seg
          label={t('priceListsPage.parts')}
          value={part}
          onChange={(p) => {
            setPart(p)
            setNotice(null)
            setActionError(null)
          }}
          options={[
            { value: 'lists', label: t('priceListsPage.part.lists') },
            {
              value: 'insurers',
              label: t('priceListsPage.part.insurers', {
                count: insurers.filter((i) => i.active).length,
              }),
            },
            { value: 'official', label: t('priceListsPage.part.official') },
          ]}
          className="self-start"
        />

        {(insurersError || actionError) && (
          <Flash key={actionError ?? 'load'} tone="error" onClose={() => setActionError(null)}>
            {actionError ?? insurersError?.message}
          </Flash>
        )}
        {notice && (
          <Flash key={notice} onClose={() => setNotice(null)}>
            {notice}
          </Flash>
        )}

        {part === 'lists' && (
          <PriceListsSection insurers={insurers.filter((i) => i.active)} onNotice={say} />
        )}
        {part === 'insurers' &&
          (insurance ? (
            <InsurersSection insurers={insurers} onNotice={say} onError={setActionError} />
          ) : (
            <Card>
              <CardBody className="flex-row items-center gap-3">
                <ShieldCheck size={18} aria-hidden="true" className="text-ink-3 flex-none" />
                <p className="text-ink-2 m-0 text-[14px]">{t('prices.insurers.parked')}</p>
              </CardBody>
            </Card>
          ))}
        {part === 'official' && (
          <>
            <p className="text-ink-2 m-0 inline-flex items-center gap-2 text-[14px]">
              <BookOpenCheck size={16} aria-hidden="true" className="text-navy-ink" />
              {t('priceListsPage.officialLead')}
            </p>
            <OfficialListSection onNotice={say} />
          </>
        )}
      </main>
    </StaffShell>
  )
}
