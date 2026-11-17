import type { ReportContext } from './defs/types'

/**
 * Who reads which reports (0182): by role. The manager reads everything; a doctor every report
 * about the patients and their care (never the money, the stock or the staff); the other
 * professions the reports of their own work (reception the files and the bookings, the nurses
 * the vital signs, the laboratory its tests, the pharmacy its sales and the stock, the cashier
 * the money). The head of a department keeps their department's people and, when the department
 * treats patients, its visits and services: the head of the finance desk reads the finance
 * reports only. The database checks the same rights again.
 */

export const roleOf = (ctx: ReportContext): string => ctx.user.dbRole ?? ctx.user.role

/** The professions that treat, test or serve patients. */
const CARE_ROLES = ['doctor', 'nurse', 'lab_tech', 'sonographer', 'pharmacist']

/** A doctor (the role, or marked by the manager) or one of the care professions. */
export const caresForPatients = (ctx: ReportContext): boolean =>
  ctx.clinical || CARE_ROLES.includes(roleOf(ctx))

/** The head (or assistant) of a department that treats patients: their department's visits and
 *  services. The head of the finance desk is not one (0182). */
export const careHead = (ctx: ReportContext): boolean => ctx.isHead && caresForPatients(ctx)
