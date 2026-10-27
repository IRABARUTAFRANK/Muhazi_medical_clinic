import { useTranslation } from 'react-i18next'
import { formatDate, formatRwf, formatTime } from '@mmc/shared'
import type { Notice } from '@/lib/api/notifications'

/** "5 min ago", "2 h ago", or the date for older ones. */
export function useAgo() {
  const { t } = useTranslation()
  return (iso: string) => {
    const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
    if (min < 1) return t('notify.justNow')
    if (min < 60) return t('notify.minAgo', { count: min })
    if (min < 24 * 60) return t('notify.hAgo', { count: Math.round(min / 60) })
    return `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`
  }
}

/** A number sent in the params (the database sends numbers; the type says text). */
const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const rwf = (v: unknown) => formatRwf(num(v))
/** A reason as typed, in quotes. */
const quoted = (v: string | null | undefined) => (v ? `“${v}”` : null)
const joinParts = (parts: (string | null | undefined)[]) =>
  parts.filter(Boolean).join(' · ') || null

/** The notice in the reader's language (automatic kinds) or as written (messages). */
export function useWording() {
  const { t } = useTranslation()
  const byText = (by: string | null | undefined) => (by ? t('notify.byPerson', { by }) : null)
  const linesText = (lines: unknown) =>
    lines == null ? null : t('notify.noteLines', { count: num(lines) })
  return (n: Notice): { title: string; body: string | null } => {
    const p = n.params ?? {}
    switch (n.kind) {
      case 'queue':
        return {
          title: t(n.urgent ? 'notify.queueUrgent' : 'notify.queue', {
            ticket: p.ticket ?? '',
            name: p.name ?? '',
            station: t(`register.stations.${p.station}`, { defaultValue: p.station ?? '' }),
          }),
          body:
            [
              p.triage ? t('notify.triage', { colour: t(`home.triage.${p.triage}`) }) : null,
              String(p.vitals) === 'false' ? t('notify.noVitals') : null,
            ]
              .filter(Boolean)
              .join(' · ') || null,
        }
      case 'no_vitals':
        // Sent to the nurses; removed as soon as anyone records the vitals.
        return {
          title: t('notify.noVitalsTitle', { ticket: p.ticket ?? '', name: p.name ?? '' }),
          body: t('notify.noVitalsBody', {
            station: t(`register.stations.${p.station}`, { defaultValue: p.station ?? '' }),
          }),
        }
      case 'queue_pool': {
        // One notice for a patient sent to several desks; the first one free takes them.
        const desks = (n.params?.stations as unknown as string[] | null) ?? []
        return {
          title: t('notify.queuePool', { ticket: p.ticket ?? '', name: p.name ?? '' }),
          body: desks.map((d) => t(`register.stations.${d}`, { defaultValue: d })).join(', '),
        }
      }
      case 'rx_not_given':
        // The pharmacy could not hand a medicine over.
        // 0100: nothing given yet: the prescriber may send it to an outside pharmacy
        return {
          title: t('notify.rxNotGiven', { item: p.item ?? '', name: p.name ?? '' }),
          body: joinParts([
            quoted(p.reason),
            String(p.outside) === 'true' ? t('notify.rxNotGivenOutside') : null,
          ]),
        }
      case 'test_cancelled':
        // The laboratory could not do a test; it left the bill.
        return {
          title: t('notify.testCancelled', { test: p.test ?? '', name: p.name ?? '' }),
          body: p.reason ? `“${p.reason}”` : null,
        }
      case 'call_next':
        // A colleague finished with a patient and asks for the next one.
        return {
          title: t('notify.callNext', {
            by: p.by ?? '',
            station: t(`register.stations.${p.station}`, { defaultValue: p.station ?? '' }),
          }),
          body: p.note ? `“${p.note}”` : null,
        }
      case 'help':
        return {
          title: t('notify.help', { by: p.by ?? '', name: p.name ?? '' }),
          body: p.note ? `“${p.note}”` : null,
        }
      case 'help_answer':
        return {
          title: t(
            (p.accepted as unknown) === true ? 'notify.helpAccepted' : 'notify.helpDeclined',
            { by: p.by ?? '', name: p.name ?? '' },
          ),
          body: null,
        }
      case 'referral': {
        // A colleague handed the patient over: who, why, and whether they want the patient back.
        const desk = t(`register.stations.${p.station}`, { defaultValue: p.station ?? '' })
        return {
          title: t('notify.referral', {
            ticket: p.ticket ?? '',
            name: p.name ?? '',
            by: p.by ?? '',
            desk,
          }),
          body:
            [
              p.note ? `“${p.note}”` : null,
              (p.back as unknown) === true ? t('notify.referralBack') : null,
            ]
              .filter(Boolean)
              .join(' · ') || null,
        }
      }
      case 'result':
        return {
          title: t(p.corrected ? 'notify.resultCorrected' : 'notify.result', {
            test: p.test ?? '',
            name: p.name ?? '',
          }),
          body: p.corrected
            ? [p.reason, p.impression].filter(Boolean).join(' · ') || null
            : (p.impression ?? null),
        }
      case 'handover':
        // 0088: a colleague hands a patient over to me: Take or Decline (home page or the visit).
        return {
          title: t('notify.handover', {
            by: p.by ?? '',
            ticket: p.ticket ?? '',
            name: p.name ?? '',
          }),
          body: quoted(p.note),
        }
      case 'handover_answer':
        // 0088: the colleague took the patient, or declined with a reason (the patient stays mine).
        return {
          title: t(
            (p.taken as unknown) === true ? 'notify.handoverTaken' : 'notify.handoverDeclined',
            { by: p.by ?? '', name: p.name ?? '' },
          ),
          body: (p.taken as unknown) === true ? null : quoted(p.reason),
        }
      case 'handover_cancelled':
        // 0088: the sender (or the manager) withdrew the handover before the answer; or it ended
        // by itself: the patient moved on (lapsed), or one of the two colleagues left the clinic.
        return {
          title:
            (p.lapsed as unknown) === true
              ? t('notify.handoverLapsed', { by: p.by ?? '', name: p.name ?? '' })
              : (p.left as unknown) === true
                ? t('notify.handoverLeft', { name: p.name ?? '', leftName: p.leftName ?? '' })
                : t('notify.handoverCancelled', { by: p.by ?? '', name: p.name ?? '' }),
          body: null,
        }
      // "Cover for me" was retired in 0088; older notices still read.
      case 'cover':
        return {
          title: t('notify.cover', {
            doctor: p.doctor ?? '',
            until: p.until ? formatTime(new Date(p.until)) : '',
          }),
          body: p.note ?? null,
        }
      case 'task':
        return {
          title: t('notify.task', { title: p.title ?? '' }),
          body: [p.name, p.due ? t('notify.due', { time: formatTime(new Date(p.due)) }) : null]
            .filter(Boolean)
            .join(' · '),
        }
      case 'task_done':
        return {
          title: t(p.notDone ? 'notify.taskNotDone' : 'notify.taskDone', {
            by: p.by ?? '',
            title: p.title ?? '',
          }),
          body: [p.name, p.reason].filter(Boolean).join(' · ') || null,
        }
      case 'inquiry':
        // the doctor named in the request is told too: reception books it, the doctor then accepts
        return {
          title: t('notify.inquiry', { name: p.name ?? '' }),
          body: t(p.forDoctor ? 'notify.inquiryDoctor' : 'notify.inquiryBody'),
        }
      case 'to_accept':
        return {
          title: t('notify.toAccept', { name: p.name ?? '' }),
          body: t('notify.toAcceptBody'),
        }
      case 'booked_arrived':
        return {
          title: t('notify.bookedArrived', { name: p.name ?? '' }),
          body: t(p.triage ? 'notify.bookedArrivedTriage' : 'notify.bookedArrivedDesk'),
        }
      case 'appt_confirmed':
        return {
          title: t('notify.apptConfirmed', { name: p.name ?? '', doctor: p.doctor ?? '' }),
          body: p.when
            ? t('notify.apptWhen', {
                when: `${formatDate(new Date(p.when))} ${formatTime(new Date(p.when))}`,
              })
            : null,
        }
      case 'deactivated_long':
        return {
          title: t('notify.deactivatedLong', { name: p.name ?? '', days: p.days ?? 30 }),
          body: t('notify.deactivatedLongBody'),
        }
      case 'appt_declined':
        return {
          title: t('notify.apptDeclined', { name: p.name ?? '', doctor: p.doctor ?? '' }),
          body: [
            p.when
              ? t('notify.apptWhen', {
                  when: `${formatDate(new Date(p.when))} ${formatTime(new Date(p.when))}`,
                })
              : null,
            p.reason ? t('notify.apptReason', { reason: p.reason }) : null,
            t('notify.apptRebook'),
          ]
            .filter(Boolean)
            .join(' · '),
        }
      case 'desks_placed':
        // 0085: on the day departments started deciding the desks, who was placed where
        return {
          title: t('notify.desksPlaced', { count: Number(p.count ?? 0) }),
          body: t('notify.desksPlacedBody'),
        }
      // ---- medicines and stock (0082 / 0083): params only, worded here
      case 'rx_cancelled':
        // the doctor cancelled a line still waiting at the pharmacy
        return {
          title: t('notify.rxCancelled', { item: p.item ?? '', name: p.name ?? '' }),
          body: joinParts([byText(p.by), quoted(p.reason)]),
        }
      case 'rx_outside':
        // 0100: the doctor sent a line waiting at the pharmacy to an outside pharmacy
        return {
          title: t('notify.rxOutside', { item: p.item ?? '', name: p.name ?? '' }),
          body: joinParts([byText(p.by), quoted(p.reason)]),
        }
      case 'refund_due':
        // a medicine came back after the bill was posted: money to give back at the cashier
        return {
          title: t('notify.refundDue', { amount: rwf(p.amount), name: p.name ?? '' }),
          body: joinParts([t('notify.refundDueItem', { item: p.item ?? '' }), quoted(p.reason)]),
        }
      case 'stock_low':
        return {
          title: t('notify.stockLow', { item: p.item ?? '', onHand: num(p.onHand) }),
          body: t('notify.stockLowBody', { level: num(p.level) }),
        }
      // the pharmacy's daily check (0097): a batch near or past its date, and the day's summary
      case 'stock_expiring':
        return {
          title: t('notify.stockExpiring', { item: p.item ?? '', count: num(p.days) }),
          body: t('notify.stockExpiringBody', {
            batch: p.batchNo ?? '',
            quantity: num(p.quantity),
            date: p.expiry ? formatDate(new Date(p.expiry)) : '',
          }),
        }
      case 'stock_expired':
        return {
          title: t('notify.stockExpired', { item: p.item ?? '', quantity: num(p.quantity) }),
          body: t('notify.stockExpiredBody', {
            batch: p.batchNo ?? '',
            date: p.expiry ? formatDate(new Date(p.expiry)) : '',
            value: rwf(p.value),
          }),
        }
      case 'stock_summary':
        return {
          title: t('notify.stockSummary'),
          body: joinParts([
            num(p.low) ? t('notify.stockSummaryLow', { count: num(p.low) }) : null,
            num(p.expiring)
              ? t('notify.stockSummaryExpiring', { count: num(p.expiring), days: num(p.days) })
              : null,
            num(p.expired) ? t('notify.stockSummaryExpired', { count: num(p.expired) }) : null,
          ]),
        }
      case 'rx_part_given':
        return {
          title: t('notify.rxPartGiven', {
            item: p.item ?? '',
            name: p.name ?? '',
            given: num(p.given),
            quantity: num(p.quantity),
          }),
          body: t('notify.rxPartGivenBody', { count: num(p.remaining) }),
        }
      case 'staff_message':
        // a free note to the manager: the text as written, from whom
        return {
          title: t('notify.staffMessage', { from: p.from ?? '' }),
          body: n.body ?? p.text ?? null,
        }
      case 'room_stock_low':
        return {
          title: t('notify.roomStockLow', {
            item: p.item ?? '',
            store: p.store ?? '',
            onHand: num(p.onHand),
          }),
          body: t('notify.roomStockLowBody', { min: num(p.min) }),
        }
      case 'room_stock_loss':
        // a holder wrote stock off or counted their room store down
        return {
          title: t('notify.roomStockLoss', {
            count: num(p.units),
            item: p.item ?? '',
            store: p.store ?? '',
          }),
          body: joinParts([byText(p.by), quoted(p.reason)]),
        }
      case 'refill_requested':
        return {
          title: t('notify.refillRequested', { number: p.number ?? '', store: p.store ?? '' }),
          body: joinParts([linesText(p.lines), byText(p.by)]),
        }
      case 'refill_declined':
        return {
          title: t('notify.refillDeclined', { number: p.number ?? '', store: p.store ?? '' }),
          body: joinParts([byText(p.by), quoted(p.reason)]),
        }
      case 'transfer_sent':
        return {
          title: t('notify.transferSent', { number: p.number ?? '', store: p.store ?? '' }),
          body: joinParts([linesText(p.lines), byText(p.by), t('notify.confirmWhatArrives')]),
        }
      case 'return_sent':
        return {
          title: t('notify.returnSent', { number: p.number ?? '', store: p.store ?? '' }),
          body: joinParts([linesText(p.lines), byText(p.by), t('notify.confirmWhatArrives')]),
        }
      case 'transfer_received':
        return {
          title: t('notify.transferReceived', {
            number: p.number ?? '',
            store: p.store ?? '',
            by: p.by ?? '',
          }),
          body:
            num(p.missing) > 0
              ? t('notify.transferMissing', { count: num(p.missing) })
              : t('notify.transferComplete'),
        }
      case 'transfer_difference':
        return {
          title: t('notify.transferDifference', { number: p.number ?? '', store: p.store ?? '' }),
          body: joinParts([
            num(p.returned) > 0 ? t('notify.differenceReturned', { count: num(p.returned) }) : null,
            num(p.lost) > 0 ? t('notify.differenceLost', { count: num(p.lost) }) : null,
            byText(p.by),
          ]),
        }
      case 'transfer_cancelled':
        return {
          title: t('notify.transferCancelled', { number: p.number ?? '', store: p.store ?? '' }),
          body: joinParts([byText(p.by), quoted(p.reason)]),
        }
      case 'store_assigned':
        return {
          title: t('notify.storeAssigned', { store: p.store ?? '' }),
          body: t('notify.storeAssignedBody'),
        }
      case 'counter_sale_to_pay':
        return {
          title: t('notify.counterSaleToPay', { number: p.number ?? '', amount: rwf(p.amount) }),
          body: p.buyer ?? t('notify.walkInBuyer'),
        }
      case 'counter_sale_paid':
        return {
          title: t('notify.counterSalePaid', { number: p.number ?? '', amount: rwf(p.amount) }),
          body: t('notify.counterSalePaidBody', { buyer: p.buyer ?? t('notify.walkInBuyer') }),
        }
      // 0088: past records (request to the manager and heads, their answer, emergency access)
      case 'access_request':
        return {
          title: t('notify.accessRequest', { by: p.by ?? '', name: p.name ?? '' }),
          body: joinParts([p.file, quoted(p.reason)]),
        }
      case 'access_answer':
        return String(p.approved) === 'true'
          ? {
              title: t('notify.accessApproved', { by: p.by ?? '', name: p.name ?? '' }),
              body: t('notify.accessApprovedBody'),
            }
          : {
              title: t('notify.accessRefused', { by: p.by ?? '', name: p.name ?? '' }),
              body: quoted(p.reason),
            }
      case 'access_emergency':
        return {
          title: t('notify.accessEmergency', { by: p.by ?? '', name: p.name ?? '' }),
          body: joinParts([quoted(p.reason), t('notify.accessEmergencyBody')]),
        }
      // 0089: the laboratory or ultrasound added a file to a test the reader asked for
      case 'file_attached':
        return {
          title: t('notify.fileAttached', {
            by: p.by ?? '',
            test: p.test ?? t('notify.fileAttachedTest'),
          }),
          body: joinParts([p.title ? quoted(p.title) : null, p.name, p.file]),
        }
      default:
        return { title: n.title ?? '', body: n.body }
    }
  }
}
