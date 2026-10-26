import type { PatientAccess } from '@/lib/api/privacy'

/** True when the privacy rules apply (a database from 0088 on). */
export const privacyOn = (access: PatientAccess | null | undefined): access is PatientAccess =>
  !!access && !access.legacy

/** The privacy notice shows: something hidden, an access in force, or a request of mine. */
export const privacyNoticeShown = (
  access: PatientAccess | null | undefined,
): access is PatientAccess =>
  privacyOn(access) &&
  (access.hiddenVisits > 0 ||
    access.via === 'request' ||
    access.via === 'emergency' ||
    access.request?.status === 'pending')
