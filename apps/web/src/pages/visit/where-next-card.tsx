import { useState } from 'react'
import { ArrowRightLeft, CornerDownLeft, Send, Wallet } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { WhoPicker } from '@/components/clinical/send-patient-card'
import { SECTION_ICON } from '@/components/clinical/service-icons'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { useBillingActions } from '@/lib/api/billing'
import { useRefer, useVisitRouting } from '@/lib/api/referrals'
import {
  SECTIONS,
  SERVICE_DESK,
  sectionName,
  useServiceStaff,
  type SectionId,
} from '@/lib/api/services'
import type { Station } from '@/lib/api/visits'
import { cn } from '@/lib/utils'
import { useConfirm } from '@/lib/confirm'

/**
 * "Where next" on the visit screen. Back to the colleague who referred the patient (one click),
 * the cashier, or a section: what the patient needs next (consultation, nursing, dental, the
 * lab…). Sent to the section, the first one free among the people who work in it takes the
 * patient, doctor or nurse alike (their department or calendar says where they work, not their
 * role); or one person of it, seeing who works now and how many patients each already has.
 * With the reason and, if wanted, "send the patient back to me afterwards".
 */
export function WhereNextCard({
  encounterId,
  myStation,
  isReception,
  closed = false,
  patientName,
  onDone,
  onError,
}: {
  encounterId: string
  /** For the question asked before the patient is sent on. */
  patientName?: string
  myStation: Station
  isReception: boolean
  /** Finished visit: nothing left to send on. */
  closed?: boolean
  onDone: (message: string) => void
  onError: (message: string | null) => void
}) {
  const { t } = useTranslation()
  const actions = useBillingActions(encounterId)
  const refer = useRefer(encounterId)
  const { data: routing = [] } = useVisitRouting(encounterId)
  const [section, setSection] = useState<SectionId | null>(null)
  const [person, setPerson] = useState('') // '' = anyone in the section
  const [note, setNote] = useState('')
  const [comeBack, setComeBack] = useState(false)
  const { data: staff, isLoading } = useServiceStaff(section)
  const sending = actions.finishStation.isPending || refer.isPending
  const deskName = (s: Station) => t(`register.stations.${s}`)
  const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))
  // The referral that brought the patient to this desk, if any.
  const here = routing.find((r) => r.station === myStation)
  const confirm = useConfirm()
  const patient = patientName || t('confirm.visit.thisPatient')

  const toCashier = async () => {
    onError(null)
    if (
      !(await confirm({
        title: t('confirm.visit.toCashier', { name: patient }),
        body: t('confirm.visit.toCashierBody'),
        confirmLabel: t('confirm.visit.sendYes'),
      }))
    )
      return
    try {
      await actions.finishStation.mutateAsync({ station: myStation, next: 'cashier' })
      onDone(t('visit.sent', { station: deskName('cashier') }))
    } catch (e) {
      onError(describe(e))
    }
  }

  const doRefer = async (i: {
    to: Station
    toUser: string | null
    service?: string | null
    note: string
    comeBack: boolean
    message: string
    /** The question asked first. */
    ask: { title: string; body: string; yes: string }
  }) => {
    onError(null)
    if (!(await confirm({ title: i.ask.title, body: i.ask.body, confirmLabel: i.ask.yes }))) return
    try {
      await refer.mutateAsync({
        from: myStation,
        to: i.to,
        toUser: i.toUser,
        service: i.service,
        note: i.note,
        comeBack: i.comeBack,
      })
      setSection(null)
      setPerson('')
      setNote('')
      onDone(i.message)
    } catch (e) {
      onError(describe(e))
    }
  }

  if (closed) return null
  const chosen = staff?.staff.find((p) => p.id === person)
  const name = section ? sectionName(section, t) : ''

  return (
    <Card className="anim-enter">
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          <Send size={16} aria-hidden="true" />
          {t('visit.next.title')}
        </span>
      </CardHeader>
      <CardBody className="gap-3">
        {/* Referred here: who sent the patient, why, and the way back */}
        {here?.referredName && (
          <div className="border-violet/30 bg-violet-bg/60 flex flex-col gap-2 rounded-md border px-3 py-2.5">
            <span className="inline-flex items-center gap-2 text-[14px] font-semibold">
              <ArrowRightLeft size={16} aria-hidden="true" className="text-violet" />
              {t('refer.cameFrom', { name: here.referredName })}
            </span>
            {here.note && <span className="text-ink-2 text-[14px]">“{here.note}”</span>}
            {here.returnStation && here.returnTo && (
              <Button
                variant="success"
                disabled={sending}
                className="self-start"
                onClick={() =>
                  void doRefer({
                    to: here.returnStation!,
                    toUser: here.returnTo,
                    note: t('refer.backNote', { desk: deskName(myStation) }),
                    comeBack: false,
                    message: t('refer.sentBack', { name: here.returnName ?? '' }),
                    ask: {
                      title: t('confirm.visit.sendBack', {
                        name: patient,
                        person: here.returnName ?? '',
                        desk: deskName(here.returnStation!),
                      }),
                      body: t('confirm.visit.sendBackBody', { person: here.returnName ?? '' }),
                      yes: t('confirm.visit.sendBackYes'),
                    },
                  })
                }
              >
                <CornerDownLeft size={16} aria-hidden="true" />
                {t('refer.sendBack', {
                  name: here.returnName ?? '',
                  desk: deskName(here.returnStation),
                })}
              </Button>
            )}
          </div>
        )}

        <p className="text-ink-2 m-0 text-[14px]">{t('visit.next.sectionLead')}</p>
        <div
          className="grid grid-cols-2 gap-2 sm:grid-cols-3"
          role="radiogroup"
          aria-label={t('visit.next.section')}
        >
          {SECTIONS.map((s) => {
            const Icon = SECTION_ICON[s]
            const on = section === s
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => {
                  setSection(on ? null : s)
                  setPerson('')
                }}
                className={cn(
                  'flex min-h-9 items-center gap-2 rounded-md border px-3 text-left text-[14px] font-semibold transition-colors',
                  on
                    ? 'border-primary bg-primary text-white'
                    : 'border-border bg-card text-ink-2 hover:bg-hover',
                )}
              >
                <Icon size={16} aria-hidden="true" className="shrink-0" />
                <span className="min-w-0 leading-tight">{sectionName(s, t)}</span>
              </button>
            )
          })}
        </div>

        {/* the section chosen: anyone in it (the first one free takes), or one person of it */}
        {section && (
          <div className="flex flex-col gap-3">
            <WhoPicker
              name={`next-${encounterId}`}
              title={t('sendPatient.whoTitle', { service: name })}
              anyone={t('sendPatient.anyoneIn', { service: name })}
              data={staff}
              loading={isLoading}
              value={person}
              onChange={setPerson}
              empty={t('sendPatient.nobody', { service: name })}
            />
            <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
              {t('refer.why')}
              <textarea
                rows={2}
                className="border-border bg-card focus:border-primary rounded-md border px-2.5 py-2 text-[14px] font-normal outline-none"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            {!isReception && (
              <label className="flex items-start gap-2 text-[14px]">
                <input
                  type="checkbox"
                  className="accent-primary mt-0.5 size-4"
                  checked={comeBack}
                  onChange={(e) => setComeBack(e.target.checked)}
                />
                <span>
                  <span className="block font-semibold">{t('refer.comeBack')}</span>
                  <span className="text-ink-3 block text-[13px]">{t('refer.comeBackHint')}</span>
                </span>
              </label>
            )}
            <Button
              variant="success"
              disabled={sending}
              className="self-start"
              onClick={() =>
                void doRefer({
                  to: section === 'triage' ? 'triage' : SERVICE_DESK[section],
                  toUser: person || null,
                  service: section === 'triage' ? null : section,
                  note,
                  comeBack: !isReception && comeBack,
                  message: t('refer.done', { to: chosen ? `${chosen.name} (${name})` : name }),
                  ask: {
                    title: t('confirm.visit.refer', {
                      name: patient,
                      to: chosen ? `${chosen.name} (${name})` : name,
                    }),
                    body: t(
                      !isReception && comeBack
                        ? 'confirm.visit.referBackBody'
                        : 'confirm.visit.referBody',
                    ),
                    yes: t('confirm.visit.sendYes'),
                  },
                })
              }
            >
              <Send size={16} aria-hidden="true" />
              {chosen
                ? t('sendPatient.goToPerson', { name: chosen.name })
                : t('sendPatient.goTo', { desk: name })}
            </Button>
          </div>
        )}

        {!isReception && (
          <div className="border-border border-t pt-3">
            <Button
              variant="tint-mint"
              disabled={sending}
              onClick={() => void toCashier()}
              className="justify-start"
            >
              <Wallet size={18} aria-hidden="true" />
              {t('visit.next.toCashier')}
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
