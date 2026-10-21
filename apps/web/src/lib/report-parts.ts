import { useTranslation } from 'react-i18next'
import { useClinicInfo } from '@/lib/api/public'
import type { MedicalReportLabels } from '@/lib/medical-report'

/** The clinic's letterhead for printed documents (name, address, contacts, licences, logo). */
export function useLetterhead() {
  const { t } = useTranslation()
  const { data: info } = useClinicInfo()
  const profile = (info?.profile ?? {}) as Record<string, unknown> & {
    name?: string
    sector?: string
    district?: string
    province?: string
    country?: string
    phone?: string
    email?: string
  }
  return {
    name: profile.name ?? 'Muhazi Medical Clinic',
    address: [profile.sector, profile.district, profile.province, profile.country]
      .filter(Boolean)
      .join(' · '),
    contacts: [profile.phone, profile.email].filter(Boolean).join(' · '),
    licences: [
      profile.moh_licence ? `${t('rxDoc.moh')} ${String(profile.moh_licence)}` : null,
      profile.tin ? `TIN ${String(profile.tin)}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
    logoUrl: `${window.location.origin}/logo.jpg`,
  }
}

/** The medical report's wording in the interface language. */
export function useMedicalReportLabels(): MedicalReportLabels {
  const { t } = useTranslation()
  const k = (key: string) => t(`medReport.${key}`)
  return {
    title: k('title'),
    titleHistory: k('titleHistory'),
    produced: k('produced'),
    patient: t('rxDoc.patient'),
    file: t('rxDoc.file'),
    ageSex: t('rxDoc.ageSex'),
    phone: k('phone'),
    allergies: t('rxDoc.allergies'),
    bloodGroup: k('bloodGroup'),
    none: t('rxDoc.none'),
    visitOf: (date) => t('medReport.visitOf', { date }),
    seenBy: k('seenBy'),
    desks: k('desks'),
    vitals: k('vitals'),
    notes: k('notes'),
    diagnoses: k('diagnoses'),
    primary: k('primary'),
    provisional: k('provisional'),
    tests: k('tests'),
    conclusion: k('conclusion'),
    notVerified: k('notVerified'),
    treatments: k('treatments'),
    medicines: k('medicines'),
    comment: k('comment'),
    nothing: k('nothing'),
    author: k('author'),
    signature: t('rxDoc.signature'),
    stamp: t('rxDoc.stamp'),
    confidential: k('confidential'),
    visitsCount: (n) => t('medReport.visitsCount', { count: n }),
  }
}
