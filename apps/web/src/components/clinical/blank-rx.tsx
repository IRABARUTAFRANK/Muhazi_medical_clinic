import { useState } from 'react'
import { Printer, UserRound, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { docStamp } from '@/lib/doc-style'
import { buildPrescriptionHtml, type RxDoc } from '@/lib/prescription-doc'
import { useLetterhead } from '@/lib/report-parts'
import { registrationText, useMyCredentials } from '@/lib/api/staff'
import { useFindPatients } from '@/lib/api/visits'
import { roleLabel } from '@/lib/roles'

/** The patient printed on the sheet (none: the name and file are left blank to write). */
export interface BlankRxPatient {
  name: string
  fileNumber: string | null
  birthDate?: string | null
  sex?: RxDoc['patient']['sex']
  weight?: number | string | null
  phone?: string | null
  insurer?: string | null
  memberNo?: string | null
}

const ROWS = [4, 6, 8, 10, 12, 15]

/**
 * 0155: a prescription sheet to write by hand — the clinic's letterhead, the patient, numbered
 * empty lines (the doctor chooses how many), the prescriber's name, registration and signature.
 * Some medicines are written with a pen, not typed: the printed template keeps the clinic's
 * look and the prescriber's identity. From the visit (the patient filled in) or the
 * Prescriptions page (a patient searched, or none).
 */
export function BlankRxForm({
  user,
  patient,
  searchable = false,
  onClose,
}: {
  user: StaffUser
  patient?: BlankRxPatient | null
  /** Prescriptions page: the patient is searched (or left blank). */
  searchable?: boolean
  onClose?: () => void
}) {
  const { t } = useTranslation()
  const letterhead = useLetterhead()
  const { data: creds } = useMyCredentials(user.id)
  const [rows, setRows] = useState(8)
  const [search, setSearch] = useState('')
  const [chosen, setChosen] = useState<BlankRxPatient | null>(null)
  const { data: hits = [] } = useFindPatients(searchable ? search : '')
  const [error, setError] = useState<string | null>(null)
  const who = patient ?? chosen

  const print = () => {
    setError(null)
    // the window opens on the click itself (a browser blocks one opened after a wait)
    const w = window.open('', '_blank')
    if (!w) return setError(t('report.popupBlocked'))
    const date = new Date()
    const doc: RxDoc = {
      number: `RX-${who?.fileNumber ?? 'MMC'}-${docStamp(date)}`,
      date,
      clinic: letterhead,
      patient: {
        name: who?.name ?? '',
        fileNumber: who?.fileNumber ?? '',
        ageSex: null,
        birthDate: who?.birthDate ?? null,
        sex: who?.sex ?? null,
        weight: who?.weight ?? null,
        phone: who?.phone ?? null,
        insurer: who?.insurer ?? null,
        memberNo: who?.memberNo ?? null,
      },
      diagnosis: null,
      medicines: [],
      givenHere: [],
      outside: false,
      blankRows: rows,
      prescriber: {
        name: user.name,
        title: creds?.specialty?.trim() || roleLabel(user, t),
        registrationNo: registrationText(creds),
      },
      printedBy: user.name,
    }
    w.document.open()
    w.document.write(buildPrescriptionHtml(doc))
    w.document.close()
  }

  return (
    <div className="border-violet/30 wash wash-violet rounded-lg2 flex flex-col gap-3 border p-3">
      <p className="text-ink-2 m-0 text-[13px]">{t('rxDoc.blank.lead')}</p>
      {searchable && (
        <div className="flex flex-col gap-1.5">
          <span className="text-ink-2 text-[13px] font-semibold">{t('rxDoc.blank.patient')}</span>
          {chosen ? (
            <span className="flex flex-wrap items-center gap-2">
              <span className="border-green/25 bg-green-bg text-green inline-flex h-5 items-center gap-1 rounded border px-1.5 text-[11px] leading-none font-medium">
                {chosen.fileNumber} · {chosen.name}
              </span>
              <Button type="button" size="sm" variant="tint-grey" onClick={() => setChosen(null)}>
                <UserRound size={14} aria-hidden="true" />
                {t('ops.inquiries.otherFile')}
              </Button>
            </span>
          ) : (
            <>
              <Field
                label={t('ops.inquiries.searchFile')}
                value={search}
                placeholder={t('ops.inquiries.searchPh')}
                onChange={(e) => setSearch(e.target.value)}
              />
              {hits.length > 0 && (
                <div className="border-card-border bg-card shadow-card rounded-lg2 flex flex-col border">
                  {hits.slice(0, 6).map((h) => (
                    <button
                      key={h.id}
                      type="button"
                      className="border-grid hover:bg-hover flex items-center gap-2 border-b px-3 py-2 text-left text-[13px] last:border-b-0"
                      onClick={() => {
                        setChosen({
                          name: `${h.surname} ${h.givenNames}`,
                          fileNumber: h.fileNumber,
                          birthDate: h.birthDate,
                          sex: h.sex,
                          phone: h.phone,
                        })
                        setSearch('')
                      }}
                    >
                      <span className="text-primary font-semibold tabular-nums">
                        {h.fileNumber}
                      </span>
                      <span className="flex-1 font-semibold">
                        {h.surname} {h.givenNames}
                      </span>
                      <span className="text-ink-3">{h.phone ?? ''}</span>
                    </button>
                  ))}
                </div>
              )}
              <span className="text-ink-3 text-[12px]">{t('rxDoc.blank.noPatient')}</span>
            </>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label={t('rxDoc.blank.rows')}
          value={String(rows)}
          onChange={(e) => setRows(Number(e.target.value))}
          wrapperClassName="w-40"
        >
          {ROWS.map((n) => (
            <option key={n} value={n}>
              {t('rxDoc.blank.rowCount', { count: n })}
            </option>
          ))}
        </Select>
        <Button type="button" variant="primary" onClick={print}>
          <Printer size={16} aria-hidden="true" />
          {t('rxDoc.blank.print')}
        </Button>
        {onClose && (
          <Button type="button" variant="ghost" onClick={onClose}>
            <X size={16} aria-hidden="true" />
            {t('staff.form.cancel')}
          </Button>
        )}
      </div>
      {error && (
        <p
          role="alert"
          className="bg-red-bg text-red m-0 rounded-lg px-2.5 py-1.5 text-[13px] font-semibold"
        >
          {error}
        </p>
      )}
    </div>
  )
}
