import { tableCell, tableFirstCell } from '@/components/dash/kit-style'
import type { PeriodStatus } from '@/lib/api/accounts'
import { cn } from '@/lib/utils'

/** The tabs of the Finance page (0179; taxes 0184; the kinds of money 0185). */
export type AccountsTab = 'money' | 'salaries' | 'taxes' | 'expenses' | 'setup'
export const ACCOUNTS_TABS: readonly AccountsTab[] = [
  'money',
  'salaries',
  'taxes',
  'expenses',
  'setup',
]

/** Shared by the Finance page's tabs (the salaries and the taxes are built alike). */
export const METHODS = ['cash', 'momo', 'airtel', 'bank', 'card'] as const
export const STATUS_TONE: Record<PeriodStatus, 'green' | 'red' | 'yellow' | 'grey'> = {
  paid: 'green',
  overdue: 'red',
  due: 'yellow',
  skipped: 'grey',
}
export const STATUSES: PeriodStatus[] = ['paid', 'due', 'overdue', 'skipped']
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
export type Msg = { ok: boolean; text: string }

/**
 * A short table of figures (a label, then one or two amounts) inside a panel that can be as
 * narrow as a phone: the label may shrink and wrap (the lists' first column keeps 11rem, which
 * pushed the amounts out of the panel) and an amount stays on one line.
 */
export const figureLabel = cn(tableFirstCell, 'min-w-0')
export const figureAmount = cn(tableCell, 'text-right whitespace-nowrap tabular-nums')
