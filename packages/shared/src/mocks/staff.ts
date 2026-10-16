import type { StaffUser } from '../types'

/** Sample staff directory. Any PIN signs in until real authentication exists. */
export const STAFF: readonly StaffUser[] = [
  { id: 'u-rec', username: 'j.uwimana', name: 'Uwimana Josiane', role: 'receptionist' },
  {
    id: 'u-nur',
    username: 'c.nyirahabimana',
    name: 'Nyirahabimana Chantal',
    role: 'nurse',
    station: 'Triage',
  },
  {
    id: 'u-doc',
    username: 'b.mukamana',
    name: 'Dr. Mukamana Béatrice',
    role: 'doctor',
    station: 'Consultation 1',
  },
  { id: 'u-cash', username: 's.mugisha', name: 'Mugisha Samuel', role: 'cashier' },
  {
    id: 'u-mgr',
    username: 't.mugabo',
    name: 'Mugabo Théogène',
    role: 'manager',
    dashboard: 'manager',
  },
  {
    id: 'u-head',
    username: 'f.ndayisaba',
    name: 'Dr. Ndayisaba Félix',
    role: 'doctor',
    station: 'Dental',
    dashboard: 'head',
    headOf: 'Dental',
  },
]

export const findStaffByUsername = (username: string): StaffUser | undefined =>
  STAFF.find((u) => u.username.toLowerCase() === username.trim().toLowerCase())
export const findStaffById = (id: string): StaffUser | undefined => STAFF.find((u) => u.id === id)
