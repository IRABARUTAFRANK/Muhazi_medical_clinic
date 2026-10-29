import {
  Banknote,
  ClipboardList,
  FlaskConical,
  IdCard,
  Package,
  Pill,
  Stethoscope,
  Users,
  type LucideIcon,
} from 'lucide-react'
import type { Hue } from '@/components/dash/kit-style'
import { ApiError, isMissingFunction } from '@/lib/api/errors'
import type { ReportGroupName } from '@/lib/reports/defs/types'

/** Each group of reports with its icon and hue (the side list, the report's header). */
export const GROUP_LOOK: Record<ReportGroupName, { icon: LucideIcon; hue: Hue }> = {
  patients: { icon: Users, hue: 'teal' },
  finance: { icon: Banknote, hue: 'mint' },
  pharmacy: { icon: Pill, hue: 'violet' },
  stock: { icon: Package, hue: 'amber' },
  clinical: { icon: Stethoscope, hue: 'navy' },
  lab: { icon: FlaskConical, hue: 'rose' },
  reception: { icon: ClipboardList, hue: 'coral' },
  staff: { icon: IdCard, hue: 'navy' },
}

/** The database is older than the report's function. */
export const needsDbUpdate = (e: unknown) =>
  e instanceof ApiError && isMissingFunction({ code: e.code, message: e.serverMessage })
