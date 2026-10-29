import { CLINICAL_REPORTS } from './defs/clinical'
import { FINANCE_REPORTS } from './defs/finance'
import { PATIENTS_REPORTS } from './defs/patients'
import { STAFF_REPORTS } from './defs/staff'
import { STOCK_REPORTS } from './defs/stock'
import type { AnyReportDef, ReportContext, ReportGroupName } from './defs/types'

/** Every report of the report centre, in the order the groups are listed. */
export const ALL_REPORTS: AnyReportDef[] = [
  ...PATIENTS_REPORTS,
  ...FINANCE_REPORTS,
  ...STOCK_REPORTS,
  ...STAFF_REPORTS,
  ...CLINICAL_REPORTS,
]

/** The groups in the side list, in this order. */
export const REPORT_GROUPS: ReportGroupName[] = [
  'patients',
  'finance',
  'pharmacy',
  'stock',
  'clinical',
  'lab',
  'reception',
  'staff',
]

/** The reports this person may run. */
export const reportsFor = (ctx: ReportContext): AnyReportDef[] =>
  ALL_REPORTS.filter((r) => r.allowed(ctx))

export const reportById = (id: string | null | undefined): AnyReportDef | undefined =>
  ALL_REPORTS.find((r) => r.id === id)
