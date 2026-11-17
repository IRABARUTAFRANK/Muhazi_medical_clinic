import type { PeriodStatus } from '@/lib/api/accounts'

/** The tabs of the Finance page (0179; taxes 0184); the route reads them from the address. */
export type AccountsTab = 'money' | 'salaries' | 'taxes' | 'expenses'
export const ACCOUNTS_TABS: readonly AccountsTab[] = ['money', 'salaries', 'taxes', 'expenses']

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
