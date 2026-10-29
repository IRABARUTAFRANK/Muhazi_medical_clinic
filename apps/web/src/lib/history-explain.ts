import { formatDate, formatRwf, formatTime } from '@mmc/shared'
import type { HistoryItem } from '@/lib/api/history'

/**
 * Turns one history item (the record as saved, what changed, the names behind the ids) into a
 * plain sentence, a few detail lines and the list of changed fields with old → new values.
 */
type TFn = (key: string, opts?: Record<string, unknown>) => string

export interface Explained {
  /** "Charged Uwase Claudine RWF 5,000 for Consultation." */
  sentence: string
  /** Extra facts: reason, reference, note… */
  lines: string[]
  /** Changed fields (updates only), already labelled and formatted. */
  changes: { label: string; from: string; to: string }[]
}

const MONEY = new Set([
  'price',
  'amount',
  'unit_price',
  'list_price',
  'total',
  'patient_share',
  'insurer_share',
  'nightly_price',
  'period_price',
  'cash_price',
])
/** Bookkeeping or id fields that say nothing to a reader on their own. */
const HIDDEN = new Set([
  'encounter_id',
  'patient_id',
  'invoice_id',
  'service_id',
  'item_id',
  'service_request_id',
  'medication_request_id',
  'price_list_id',
  'sample_id',
  'supersedes_id',
  'template_id',
  'series_id',
  'coverage_id',
  'payer_id',
  'day_close_id',
  'pool_id',
  'guardian_patient_id',
  'merged_into',
  'requester_id',
  'prescriber_id',
  'cashier_id',
  'performer_id',
  'dispenser_id',
  'batch_id',
  'posted_by',
  'closed_by',
  'approved_by',
  'accepted_by',
  'done_by',
  'verified_by',
  'entered_by',
  'entered_for',
  'source_id',
  'source_type',
  'user_id',
  'provider_status',
  'flags',
  'extra',
  'attachments',
  'tax_fields',
])
const PERSON_FIELDS: Record<string, keyof NonNullable<HistoryItem['names']>> = {
  assigned_to: 'staff',
  taken_by: 'staff',
  given_by: 'staff',
  referred_by: 'referredBy',
  return_to: 'returnTo',
  practitioner_id: 'practitioner',
  responsible_practitioner_id: 'practitioner',
  bed_id: 'bed',
  department_id: 'department',
}

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i

const str = (v: unknown): string => (v == null ? '' : String(v))
const humanize = (f: string) => {
  const s = f.replace(/_id$/, '').replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function explain(h: HistoryItem, t: TFn): Explained {
  const row = h.row ?? {}
  const names = h.names ?? {}
  const r = (k: string) => str(row[k])
  const station = (s: string) =>
    s ? t(`register.stations.${s}`, { defaultValue: s.charAt(0).toUpperCase() + s.slice(1) }) : ''
  const value = (k: string) => t(`history.values.${k}`, { defaultValue: k.replace(/_/g, ' ') })
  const money = (v: unknown) => (v == null || v === '' ? '' : formatRwf(Number(v)))
  const changed = (f: string) => h.changes?.find((c) => c.f === f)
  const set = (f: string) => {
    const c = changed(f)
    return !!c && c.from == null && c.to != null
  }
  const patient = h.patient ?? t('history.aPatient')
  const file = names.file ? ` (${names.file})` : ''
  const P = { patient: `${patient}${file}` }

  const fmt = (f: string, v: unknown): string => {
    if (v == null || v === '') return t('history.emptyValue')
    if (typeof v === 'boolean') return t(v ? 'history.yes' : 'history.no')
    if (MONEY.has(f) && !Number.isNaN(Number(v))) return formatRwf(Number(v))
    if (f === 'station' || f === 'return_station' || f === 'office') return station(str(v))
    if (f === 'method') return t(`visit.payment.methods.${str(v)}`, { defaultValue: str(v) })
    if (f === 'working_hours' && typeof v === 'object')
      return t('history.workdays', { count: Object.keys(v as object).length })
    if (Array.isArray(v))
      return v.length ? v.map((x) => fmt(f, x)).join(', ') : t('history.emptyValue')
    if (typeof v === 'object') return JSON.stringify(v).slice(0, 80)
    const s = str(v)
    if (ISO_TS.test(s)) {
      const d = new Date(s)
      return `${formatDate(d)} ${formatTime(d)}`
    }
    if (ISO_DAY.test(s)) return formatDate(new Date(`${s}T00:00:00`))
    if (UUID.test(s)) return t('history.someone')
    if (
      /^[a-z_]+$/.test(s) &&
      (f === 'status' ||
        f.endsWith('type') ||
        f === 'priority' ||
        f === 'triage_level' ||
        f === 'calendar_visibility' ||
        f === 'category')
    )
      return value(s)
    return s
  }

  const changes: Explained['changes'] = (h.changes ?? [])
    .filter((c) => !HIDDEN.has(c.f) || PERSON_FIELDS[c.f])
    .map((c) => {
      const person = PERSON_FIELDS[c.f]
      const label = t(`history.fields.${c.f}`, { defaultValue: humanize(c.f) })
      if (person) {
        const now = names[person]
        return {
          label,
          from: c.from == null ? t('history.emptyValue') : t('history.someoneElse'),
          to: c.to == null ? t('history.emptyValue') : (now ?? t('history.someone')),
        }
      }
      return { label, from: fmt(c.f, c.from), to: fmt(c.f, c.to) }
    })

  const lines: string[] = []
  const line = (key: string, v: unknown) => {
    const s = str(v).trim()
    if (s) lines.push(t(`history.line.${key}`, { value: s }))
  }
  const deleted = h.action === 'delete' || set('deleted_at')
  let sentence: string
  const say = (key: string, opts: Record<string, unknown> = {}) =>
    t(`history.say.${key}`, { ...P, ...opts })

  switch (h.entity) {
    case 'profiles': {
      const target = names.target ?? t('history.anEmployee')
      if (h.action === 'login') {
        sentence = say(
          h.reason === 'code' ? 'loginCode' : h.reason === 'trusted' ? 'loginTrusted' : 'login',
        )
        break
      }
      const act = r('manage_staff')
      if (act === 'set_active' || (!act && row.active !== undefined))
        sentence = say(row.active === false ? 'staffOff' : 'staffOn', { target })
      else if (act === 'reset_pin') sentence = say('staffPin', { target })
      else if (act === 'set_email') sentence = say('staffEmail', { target })
      else if (act === 'create') sentence = say('staffNew', { target })
      else sentence = say('staffEdit', { target })
      if (row.role) line('role', t(`staff.roles.${r('role')}`, { defaultValue: r('role') }))
      if (row.confirmed_with_code === true) lines.push(t('history.line.confirmed'))
      break
    }
    case 'setting':
      sentence = say('setting', {
        key: t(`history.settings.${r('key')}`, { defaultValue: r('key') }),
      })
      break
    case 'patient':
      sentence =
        h.action === 'create' ? say('patientNew') : deleted ? say('patientDel') : say('patientEdit')
      if (h.action === 'create') {
        line('phone', row.phone_1)
        line('sex', row.sex ? value(r('sex')) : '')
      }
      break
    case 'encounter':
      if (h.action === 'create') {
        sentence = say('visitNew', { type: value(r('type')) })
        if (row.triage_level) line('triage', value(r('triage_level')))
        line('reason', row.triage_reason)
      } else if (changed('status') && row.status === 'closed') sentence = say('visitClosed')
      else if (changed('status')) sentence = say('visitReopened')
      else sentence = say('visitEdit')
      line('reopen', row.reopen_reason)
      break
    case 'queue_entry': {
      const st = station(r('station'))
      const ticket = r('ticket_no') || '—'
      if (h.action === 'create') {
        sentence = say(row.referred_by ? 'queueReferred' : 'queueNew', {
          station: st,
          ticket,
          by: names.referredBy ?? '',
        })
        line('note', row.referral_note)
        if (row.return_station)
          line(
            'comeBack',
            `${station(r('return_station'))}${names.returnTo ? ` · ${names.returnTo}` : ''}`,
          )
      } else if (set('finished_at')) sentence = say('queueDone', { station: st, ticket })
      else if (set('taken_by') || set('started_at'))
        sentence = say('queueTaken', { station: st, ticket })
      else if (changed('assigned_to'))
        sentence = say('queueAssigned', {
          station: st,
          ticket,
          staff: names.staff ?? t('history.someone'),
        })
      else if (set('called_at')) sentence = say('queueCalled', { station: st, ticket })
      else if (deleted) sentence = say('queueRemoved', { station: st, ticket })
      else sentence = say('queueEdit', { station: st, ticket })
      break
    }
    case 'observation': {
      const what =
        r('label') ||
        t(`triage.vitals.${r('code')}`, { defaultValue: r('code').replace(/^custom_/, '') })
      const v = `${r('value_num') || r('value_text')}${row.unit ? ` ${r('unit')}` : ''}`
      sentence = say(h.action === 'create' ? 'vital' : 'vitalEdit', { what, value: v })
      if (names.performer && h.actor && names.performer !== h.actor)
        line('measuredBy', names.performer)
      break
    }
    case 'invoice_line': {
      const qty = Number(row.quantity ?? 1)
      const amount = formatRwf(Math.round(Number(row.unit_price ?? 0) * qty))
      const what = r('description') || names.service || names.item || '—'
      sentence = deleted
        ? say('chargeDel', { what, amount })
        : say(h.action === 'create' ? 'charge' : 'chargeEdit', { what, amount })
      if (qty > 1) line('qty', `${qty} × ${money(row.unit_price)}`)
      if (Number(row.discount_pct) > 0)
        line(
          'discount',
          `${r('discount_pct')} %${row.discount_reason ? ` · ${r('discount_reason')}` : ''}`,
        )
      if (row.price_origin === 'manual') line('typedPrice', row.manual_reason || t('history.yes'))
      if (row.office) line('desk', station(r('office')))
      line('reason', h.reason)
      break
    }
    case 'payment':
      sentence = say('payment', {
        amount: money(row.amount),
        method: t(`visit.payment.methods.${r('method')}`, { defaultValue: r('method') }),
      })
      line('reference', row.reference)
      line('phone', row.payer_phone)
      line('bill', names.invoice)
      break
    case 'invoice':
      if (h.action === 'create') sentence = say('billNew')
      else if (changed('status') && row.status === 'posted')
        sentence = say('billPosted', { number: names.invoice ?? '', total: money(row.total) })
      else sentence = say('billEdit', { number: names.invoice ?? '' })
      break
    case 'condition':
      sentence = say(deleted ? 'dxDel' : 'dx', {
        text: r('text'),
        code: r('icd10_code') || '—',
        type: value(r('type')),
      })
      if (row.provisional === true) lines.push(t('history.line.provisional'))
      break
    case 'medication_request': {
      const item = names.item ?? t('history.aMedicine')
      if (set('given_at')) sentence = say('medGiven', { item })
      else if (h.action === 'create') {
        sentence = say('rx', { item })
        line(
          'dose',
          [
            row.dose,
            row.route,
            row.frequency,
            row.duration_days ? t('history.days', { count: Number(row.duration_days) }) : '',
          ]
            .filter(Boolean)
            .join(' · '),
        )
        line('instructions', row.instructions)
        line('allergy', row.allergy_override_reason)
      } else sentence = deleted ? say('rxDel', { item }) : say('rxEdit', { item })
      break
    }
    case 'medication_dispense':
      sentence = say('dispense', { item: names.item ?? t('history.aMedicine') })
      line('reason', row.substitution_reason)
      break
    case 'service_request': {
      const test = names.service ?? t('history.aTest')
      if (h.action === 'create') {
        sentence = say(
          row.priority === 'urgent' || row.priority === 'stat' ? 'orderUrgent' : 'order',
          { test },
        )
        line('reason', row.reason)
      } else if (changed('status')) {
        const c = changed('status')!
        sentence = say('orderStatus', {
          test,
          from: t(`lab.status.${str(c.from)}`, { defaultValue: str(c.from) }),
          to: t(`lab.status.${str(c.to)}`, { defaultValue: str(c.to) }),
        })
      } else sentence = say('orderEdit', { test })
      break
    }
    case 'diagnostic_report': {
      const test = names.service ?? t('history.aTest')
      sentence = set('verified_at') ? say('resultVerified', { test }) : say('result', { test })
      line('result', row.impression || row.findings)
      break
    }
    case 'internal_task':
      if (set('done_at')) sentence = say('taskDone', { title: r('title') })
      else
        sentence = say('task', {
          title: r('title'),
          to:
            names.staff ??
            (row.assigned_role ? t(`staff.roles.${r('assigned_role')}`) : t('history.someone')),
        })
      line('note', row.detail)
      break
    case 'appointment': {
      const when = row.starts_at ? fmt('starts_at', row.starts_at) : t('history.noTime')
      const who = h.patient || r('contact_name') || t('history.aPatient')
      if (h.action === 'create')
        sentence = say('apptNew', {
          who,
          when,
          doctor: names.practitioner ?? t('history.anyDoctor'),
        })
      else if (changed('status'))
        sentence = say('apptStatus', { who, when, status: value(r('status')) })
      else sentence = say('apptEdit', { who, when })
      line('reason', row.reason || row.cancel_reason)
      line('phone', row.contact_phone)
      break
    }
    case 'bed_stay':
      if (set('discharged_at')) sentence = say('bedOut', { bed: names.bed ?? '—' })
      else if (h.action === 'create')
        sentence = say('bedIn', { bed: names.bed ?? '—', count: Number(row.planned_nights ?? 1) })
      else sentence = say('bedEdit', { bed: names.bed ?? '—' })
      if (row.nightly_price != null) line('nightly', money(row.nightly_price))
      break
    case 'bed':
      sentence = say(
        h.action === 'create' ? 'bedAdded' : changed('status') ? 'bedStatus' : 'bedChanged',
        {
          bed: names.target ?? r('name'),
          status: value(r('status')),
        },
      )
      break
    case 'service':
      sentence = say(deleted ? 'treatDel' : h.action === 'create' ? 'treatNew' : 'treatEdit', {
        name: names.target ?? r('name_en'),
      })
      if (names.department) line('department', names.department)
      break
    case 'department':
      sentence = say(deleted ? 'deptDel' : h.action === 'create' ? 'deptNew' : 'deptEdit', {
        name: r('name'),
      })
      if (deleted) lines.push(t('history.line.deptStaff'))
      break
    case 'service_category':
      sentence = say(deleted ? 'catDel' : h.action === 'create' ? 'catNew' : 'catEdit', {
        name: r('name_en'),
        kind: t(`prices.cat.kinds.${r('kind')}`, { defaultValue: r('kind') }),
      })
      break
    case 'price_list_item':
      sentence = say(h.action === 'create' ? 'priceSet' : 'priceChanged', {
        name: names.service ?? names.item ?? '—',
        price: money(row.price),
      })
      break
    case 'practitioner':
      sentence = say('calendar', {
        name: names.target ?? r('names'),
        who: value(r('calendar_visibility') || 'public'),
      })
      break
    case 'patient_handover': {
      // 0088: a patient handed over to a colleague, and the answer
      const status = changed('status') ? r('status') : ''
      sentence =
        h.action === 'create'
          ? say('handoverNew')
          : status === 'taken'
            ? say('handoverTaken')
            : status === 'declined'
              ? say('handoverDeclined')
              : status === 'cancelled'
                ? say('handoverCancelled')
                : status === 'lapsed'
                  ? say('handoverLapsed')
                  : say('handoverEdit')
      line('note', row.note)
      if (status === 'declined') line('reason', row.reason)
      break
    }
    case 'payer':
      sentence = say(
        deleted ? 'insurerDel' : h.action === 'create' ? 'insurerNew' : 'insurerEdit',
        {
          name: names.target ?? r('name'),
        },
      )
      break
    default:
      sentence = t('history.say.generic', {
        verb: t(`history.verbs.${h.action}`, { defaultValue: h.action }),
        what: t(`history.entities.${h.entity}`, { defaultValue: h.entity }),
        name: r('name') || r('title') || r('description') || r('name_en') || r('code'),
      })
  }
  if (h.reason && h.entity !== 'profiles' && h.entity !== 'invoice_line') line('reason', h.reason)

  return { sentence, lines, changes }
}
