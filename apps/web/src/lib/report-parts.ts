import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useClinicInfo } from '@/lib/api/public'
import type { MedicalReportLabels } from '@/lib/medical-report'
import { useSession } from '@/store/session'
import {
  letterheadFrom,
  makeDocLabels,
  type DocLabels,
  type Letterhead,
  type ProfileLike,
} from '@/lib/doc-style'

/**
 * The React side of the document standard: the clinic's letterhead, the shared wording and who
 * prints, read from the settings, the translations and the session. The layout lives in
 * `doc-style.ts` (pure functions), which every document builder imports.
 */

/** The shared wording of every printed document, in the interface language. */
export function useDocLabels(): DocLabels {
  const { t, i18n } = useTranslation()
  return useMemo(
    () => makeDocLabels((key, vars) => t(key, vars ?? {}) as string),
    // the wording changes with the language only
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [i18n.language],
  )
}

/** Full name of the user who prints ("Printed … by …"). */
export function usePrintedBy(): string {
  return useSession((s) => s.user?.name ?? '')
}

/** The letterhead fields plus the older pre-joined strings that some builders still read. */
export interface LetterheadWithLegacy extends Letterhead {
  /** @deprecated use legalName */
  name: string
  /** @deprecated use addressLine (+ poBox) */
  address: string
  /** @deprecated use phone and email */
  contacts: string
  /** @deprecated use tin, mohLicence and fdaLicence */
  licences: string
}

/**
 * The clinic's letterhead for printed documents, as structured fields (legal name, address,
 * phone, email, TIN, MoH and FDA licences, P.O. Box, logo, opening hours). Missing values are
 * null and are never printed. Each builder lays them out with `letterheadHtml` from doc-style.
 */
export function useLetterhead(): LetterheadWithLegacy {
  const { t } = useTranslation()
  const labels = useDocLabels()
  const { data: info } = useClinicInfo()
  return useMemo(() => {
    const profile = (info?.profile ?? {}) as ProfileLike
    const shortDays = t('days.short', { returnObjects: true }) as unknown
    const lh = letterheadFrom(profile, labels, {
      logoUrl: `${window.location.origin}/logo.jpg`,
      hours: info?.hours ?? null,
      shortDays: Array.isArray(shortDays) ? (shortDays as string[]) : [],
    })
    const pairs = (list: [string, string | null][]) =>
      list
        .filter(([, v]) => !!v)
        .map(([k, v]) => `${k}: ${v}`)
        .join('   ')
    return {
      ...lh,
      name: lh.legalName,
      address: [lh.addressLine, lh.poBox ? `${labels.poBox} ${lh.poBox}` : null]
        .filter(Boolean)
        .join(', '),
      contacts: pairs([
        [labels.tel, lh.phone],
        [labels.email, lh.email],
      ]),
      licences: pairs([
        [labels.tin, lh.tin],
        [labels.mohLicence, lh.mohLicence],
        [labels.fdaLicence, lh.fdaLicence],
      ]),
    }
  }, [info, labels, t])
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
