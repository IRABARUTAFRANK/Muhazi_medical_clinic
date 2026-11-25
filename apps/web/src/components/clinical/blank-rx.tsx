import { useState } from 'react'
import { Printer, UserRound, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAskRxPrint } from '@/components/clinical/rx-print-ask'
import type { StaffUser } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
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

/** The most lines on one sheet (beyond a page the lines continue on the next). */
const MAX_ROWS = 30

/**
 * 0155: a prescription sheet to write by hand — the clinic's letterhead, the patient, numbered
 * empty lines (the doctor chooses how many), the prescriber's name, registration and signature.
 * Some medicines are written with a pen, not typed: the printed template keeps the clinic's
 * look and the prescriber's identity. From the visit (the patient filled in), the
 * Prescriptions page (a patient searched, or none) or the report centre (0197: no patient at
 * all; printed by someone who does not prescribe, the prescriber's lines are left to write).
 */
export function BlankRxForm({
  user,
  patient,
  searchable = false,
  signs = true,
  onClose,
}: {
  user: StaffUser
  patient?: BlankRxPatient | null
  /** Prescriptions page: the patient is searched (or left blank). */
  searchable?: boolean
  /** The person printing prescribes: their name, title and registration are printed. False (the
   *  manager printing sheets for the doctors): ruled blanks, the prescriber writes them. */
  signs?: boolean
  onClose?: () => void
}) {
  const { t } = useTranslation()
  const askRxPrint = useAskRxPrint()
  const letterhead = useLetterhead()
  const { data: creds } = useMyCredentials(user.id)
  // the doctor types how many lines (1–30); an emptied field is typed again, not refused
  const [rows, setRows] = useState('8')
  const typed = Math.floor(Number(rows))
  const lines = typed >= 1 ? Math.min(MAX_ROWS, typed) : 0
  const [search, setSearch] = useState('')
  const [chosen, setChosen] = useState<BlankRxPatient | null>(null)
  const { data: hits = [] } = useFindPatients(searchable ? search : '')
  const [error, setError] = useState<string | null>(null)
  const who = patient ?? chosen

  const print = async () => {
    setError(null)
    // 0204: whether to put the prescriber's registration no. on it, asked first; the window opens
    // on that answer's click (a browser blocks one opened long after a click)
    const ask = await askRxPrint()
    if (!ask.ok) return
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
      showRegistration: ask.showRegistration,
      blankRows: lines,
      prescriber: signs
        ? {
            name: user.name,
            title: creds?.specialty?.trim() || roleLabel(user, t),
            registrationNo: registrationText(creds),
          }
        : { name: '', title: '', registrationNo: null },
      printedBy: user.name,
    }
    w.document.open()
    w.document.write(buildPrescriptionHtml(doc))
    w.document.close()
  }

  return (
    <div className="border-violet/30 wash wash-violet rounded-lg2 flex flex-col gap-3 border p-3">
      <p className="text-ink-2 m-0 text-[13px]">
        {t(signs ? 'rxDoc.blank.lead' : 'rxDoc.blank.leadToSign')}
      </p>
      {/* the report centre: no patient at all, said in words */}
      {!searchable && !patient && (
        <p className="text-ink-3 m-0 text-[12px]">{t('rxDoc.blank.noPatient')}</p>
      )}
      {searchable && (
        <div className="flex flex-col gap-1.5">
          <span className="text-ink-2 text-[13px] font-semibold">{t('rxDoc.blank.patient')}</span>
          {chosen ? (
            <span className="flex flex-wrap items-center gap-2">
              <span className="border-green/25 bg-green-bg text-green inline-flex min-h-5 max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] leading-tight font-medium wrap-anywhere">
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
                      className="border-grid hover:bg-hover flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b px-3 py-2 text-left text-[13px] last:border-b-0"
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
                      {/* the phone goes under a long name on a narrow screen */}
                      <span className="min-w-0 flex-[1_1_8rem] font-semibold">
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
        <Field
          label={t('rxDoc.blank.rows')}
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_ROWS}
          step={1}
          value={rows}
          onChange={(e) => setRows(e.target.value)}
          wrapperClassName="w-40"
        />
        <Button type="button" variant="primary" onClick={() => void print()} disabled={!lines}>
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
