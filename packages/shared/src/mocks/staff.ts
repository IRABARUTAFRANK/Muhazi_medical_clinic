import type { StaffUser } from '../types'

/** Sample staff directory. Any PIN and any six-digit code sign in until real authentication exists. */
export const STAFF: readonly StaffUser[] = [
  {
    id: 'u-rec',
    staffId: 'MMC-S-0001',
    username: 'j.uwimana',
    name: 'Uwimana Josiane',
    role: 'receptionist',
    email: 'j.uwimana@example.com',
  },
  {
    id: 'u-nur',
    staffId: 'MMC-S-0002',
    username: 'c.nyirahabimana',
    name: 'Nyirahabimana Chantal',
    role: 'nurse',
    station: 'Triage',
    email: 'c.nyirahabimana@example.com',
  },
  {
    id: 'u-doc',
    staffId: 'MMC-S-0003',
    username: 'b.mukamana',
    name: 'Dr. Mukamana Béatrice',
    role: 'doctor',
    station: 'Consultation 1',
    email: 'b.mukamana@example.com',
  },
  {
    id: 'u-cash',
    staffId: 'MMC-S-0004',
    username: 's.mugisha',
    name: 'Mugisha Samuel',
    role: 'cashier',
    email: 's.mugisha@example.com',
  },
  {
    id: 'u-mgr',
    staffId: 'MMC-S-0005',
    username: 't.mugabo',
    name: 'Mugabo Théogène',
    role: 'manager',
    dashboard: 'manager',
    email: 't.mugabo@example.com',
  },
  {
    id: 'u-head',
    staffId: 'MMC-S-0006',
    username: 'f.ndayisaba',
    name: 'Dr. Ndayisaba Félix',
    role: 'doctor',
    station: 'Dental',
    dashboard: 'head',
    headOf: 'Dental',
    email: 'f.ndayisaba@example.com',
  },
]

export const findStaffByUsername = (username: string): StaffUser | undefined =>
  STAFF.find((u) => u.username.toLowerCase() === username.trim().toLowerCase())
export const findStaffById = (id: string): StaffUser | undefined => STAFF.find((u) => u.id === id)
export const findStaffByStaffId = (staffId: string): StaffUser | undefined =>
  STAFF.find((u) => u.staffId === normalizeStaffId(staffId))

/** "mmc-s-12" → "MMC-S-0012"; a bare number is accepted too. */
export const normalizeStaffId = (raw: string): string => {
  const digits = raw.replace(/\D/g, '')
  if (!digits) return raw.trim().toUpperCase()
  return `MMC-S-${digits.slice(-4).padStart(4, '0')}`
}
export const STAFF_ID_RE = /^MMC-S-[0-9]{4}$/
