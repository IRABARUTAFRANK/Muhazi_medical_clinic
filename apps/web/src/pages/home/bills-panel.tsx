import type { CSSProperties, ReactNode } from 'react'
import { FolderOpen, Receipt, Wallet } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf } from '@mmc/shared'
import { Empty, Panel, Pill } from '@/components/dash/kit'
import { buttonVariants } from '@/components/ui/button'
import { ShownList } from '@/components/ui/list-tools'
import { StaffLink } from '@/components/staff/staff-link'
import type { HomeBill } from '@/lib/api/home'

/**
 * The bills still to collect, each opening its visit: "Take payment" for whoever the manager
 * allows to take payments, "Open the visit" for the others (a cashier switched off still sees
 * them). The cashier's home, and the home of anyone else given "Take payments".
 */
export function OpenBillsPanel({
  bills,
  canTake,
  i = 1,
  footer,
}: {
  bills: HomeBill[]
  canTake: boolean
  i?: number
  /** Under the list (the link to the Bills page). */
  footer?: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <Panel
      i={i}
      icon={Receipt}
      tint="coral"
      title={t('home.openBills')}
      right={t('home.billsDue', {
        count: bills.length,
        amount: formatRwf(bills.reduce((x, b) => x + b.balance, 0)),
      })}
    >
      {bills.length === 0 ? (
        <Empty>{t('home.noOpenBills')}</Empty>
      ) : (
        <ShownList items={bills} step={6}>
          {(shown) => (
            <div className="flex flex-col">
              {shown.map((b, n) => (
                <div
                  key={b.encounterId}
                  className="border-grid flex min-h-10 flex-wrap items-center gap-2.5 border-b py-1.5 text-[14px] last:border-b-0"
                  style={{ '--i': n } as CSSProperties}
                >
                  <Pill tint="amber" icon={Receipt}>
                    {b.ticket ?? '—'}
                  </Pill>
                  {/* the name keeps 10 rem: in a narrow column the amount and the button go
                      under it instead of cutting the name to a few letters */}
                  <span className="min-w-[min(10rem,100%)] flex-1">
                    <span className="block truncate font-semibold">{b.name}</span>
                    <span className="text-ink-3 block truncate text-[13px]">
                      {b.file}
                      {b.station
                        ? ` · ${t('home.atStation', { station: t(`register.stations.${b.station}`, { defaultValue: b.station }) })}`
                        : ''}
                    </span>
                  </span>
                  <span className="font-semibold whitespace-nowrap tabular-nums">
                    {formatRwf(b.balance)}
                  </span>
                  <StaffLink
                    to="/app/visit"
                    search={{ encounter: b.encounterId }}
                    className={buttonVariants({
                      // paying is mint; without the right to take payments the row only opens
                      variant: !canTake ? 'tint-blue' : n === 0 ? 'success' : 'tint-mint',
                      size: 'sm',
                    })}
                  >
                    {canTake ? (
                      <Wallet size={14} aria-hidden="true" />
                    ) : (
                      <FolderOpen size={14} aria-hidden="true" />
                    )}
                    {t(canTake ? 'home.takePayment' : 'finance.openVisit')}
                  </StaffLink>
                </div>
              ))}
            </div>
          )}
        </ShownList>
      )}
      {footer && <div className="flex flex-wrap gap-2">{footer}</div>}
    </Panel>
  )
}
