import { useTranslation } from 'react-i18next'
import { BlankRxForm } from '@/components/clinical/blank-rx'
import { IconChip } from '@/components/dash/kit'
import { card } from '@/components/dash/kit-style'
import type { ReportContext } from '@/lib/reports/defs/types'
import { signsPrescriptions, type SheetDef } from '@/lib/reports/sheets'
import { cn } from '@/lib/utils'
import { SHEETS_LOOK } from './report-look'

/**
 * 0197: a sheet printed empty from the report centre (the blank prescription): its name, what it
 * is, how many lines, Print. No patient is chosen here: the visit's own button prints the sheet
 * with the patient's name on it.
 */
export function ReportSheet({ sheet, ctx }: { sheet: SheetDef; ctx: ReportContext }) {
  const { t } = useTranslation()
  return (
    <section className={cn(card, 'gap-3')}>
      <div className="flex flex-wrap items-start gap-3">
        <IconChip icon={SHEETS_LOOK.icon} tint={SHEETS_LOOK.hue} />
        <div className="min-w-[min(220px,100%)] flex-1">
          <h2 className="text-ink m-0 text-[20px] leading-tight font-semibold">{t(sheet.title)}</h2>
          <p className="text-ink-2 m-0 mt-1 max-w-[760px] text-[14px] leading-snug">
            {t(sheet.description)}
          </p>
        </div>
      </div>
      <BlankRxForm user={ctx.user} signs={signsPrescriptions(ctx)} />
      <p className="text-ink-3 m-0 max-w-[760px] text-[13px] leading-snug">
        {t('reports.sheets.blankRx.withPatient')}
      </p>
    </section>
  )
}
