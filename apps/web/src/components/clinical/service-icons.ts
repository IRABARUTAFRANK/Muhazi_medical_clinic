import {
  Activity,
  Baby,
  FlaskConical,
  Pill,
  Ribbon,
  Scan,
  Scissors,
  Smile,
  Stethoscope,
  Syringe,
  type LucideIcon,
} from 'lucide-react'
import type { SectionId } from '@/lib/api/services'

/** The symbol of each section: triage and the clinic's services. */
export const SECTION_ICON: Record<SectionId, LucideIcon> = {
  triage: Activity,
  consultation: Stethoscope,
  dental: Smile,
  laboratory: FlaskConical,
  ultrasound: Scan,
  nursing: Syringe,
  surgery: Scissors,
  circ: Scissors,
  fp: Baby,
  hiv: Ribbon,
  pharmacy: Pill,
}
