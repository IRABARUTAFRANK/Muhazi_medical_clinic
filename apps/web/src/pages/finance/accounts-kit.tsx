import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { FileText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Msg } from './accounts-tabs'

/** The small pieces the Finance page's tabs share (0179, 0181, 0184). */

export function Note({ msg }: { msg: Msg }) {
  return (
    <p
      className={cn(
        'm-0 rounded-md px-3 py-2 text-[14px] font-medium',
        msg.ok ? 'bg-green-bg text-green' : 'bg-red-bg text-red',
      )}
    >
      {msg.text}
    </p>
  )
}

/** The same figures in the report centre, with its filters, columns, grouping and printing (0181). */
export function ReportsLink({ id }: { id: string }) {
  const { t } = useTranslation()
  return (
    <Link
      to="/app/reports"
      search={{ r: id }}
      className={cn(buttonVariants({ variant: 'tint-teal', size: 'md' }))}
    >
      <FileText size={16} aria-hidden="true" />
      {t('accounts.inReports')}
    </Link>
  )
}

/** A form inside the side panel: a bordered box with its own heading. */
export function PanelForm({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-border bg-surface rounded-md border p-3">
      <h3 className="text-ink m-0 mb-3 text-[15px] font-semibold">{title}</h3>
      {children}
    </div>
  )
}
