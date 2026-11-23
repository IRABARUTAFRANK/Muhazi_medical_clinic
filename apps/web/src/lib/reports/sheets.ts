import type { ReportContext } from './defs/types'

/**
 * 0197: the sheets printed empty, to write by hand, in the report centre (/app/reports): the
 * clinic's letterhead and ruled lines, no patient chosen and nothing read from the database. A
 * sheet is not a report (no table, no filters, no columns): it keeps its own short list, shown as
 * the first group of the report centre's list, and the report contract (defs/types.ts) stays a
 * table. `?r=sheets.blankRx` opens one, like a report.
 */
export interface SheetDef {
  /** 'sheets.blankRx' (URL ?r=…); never the id of a report. */
  id: string
  /** i18n keys */
  title: string
  description: string
  /** Who finds it in the list. */
  allowed: (ctx: ReportContext) => boolean
}

/**
 * The person printing prescribes: a doctor (the role, or marked by the manager), as for the
 * "Blank prescription" button of a visit. Their name, title and registration number are printed
 * on the sheet; for anyone else (the manager printing sheets for the doctors) those lines are
 * left to write.
 */
export const signsPrescriptions = (ctx: ReportContext): boolean => ctx.clinical

export const BLANK_RX_SHEET = 'sheets.blankRx'

export const ALL_SHEETS: SheetDef[] = [
  {
    id: BLANK_RX_SHEET,
    title: 'reports.sheets.blankRx.title',
    description: 'reports.sheets.blankRx.description',
    // the doctors (who print it today from a visit) and the manager, who prints sheets for the
    // doctors: the prescriber's lines are then left to write
    allowed: (ctx) => ctx.isManager || signsPrescriptions(ctx),
  },
]

/** The sheets this person may print. */
export const sheetsFor = (ctx: ReportContext): SheetDef[] =>
  ALL_SHEETS.filter((s) => s.allowed(ctx))
