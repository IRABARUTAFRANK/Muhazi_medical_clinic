import {
  Activity,
  Baby,
  FlaskConical,
  PersonStanding,
  Pill,
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
  physio: PersonStanding,
  laboratory: FlaskConical,
  ultrasound: Scan,
  nursing: Syringe,
  surgery: Scissors,
  circ: Scissors,
  fp: Baby,
  pharmacy: Pill,
}
